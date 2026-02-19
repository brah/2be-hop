const mysql = require('mysql');
const path = require('path');
const config = require(path.join(__dirname, 'config.json'));

let con;

// Creates a fresh connection object, attaches the error handler, and connects.
// Must create a new object each time — mysql connections are one-shot and cannot
// be reconnected after end() is called.
function dbConnect() {
	con = mysql.createConnection({
		host: config.dbhost,
		database: config.dbname,
		user: config.dbuser,
		password: config.dbpassword,
		port: config.dbport,
	});

	con.on('error', (err) => {
		console.log(err);
		if (['PROTOCOL_CONNECTION_LOST', 'ECONNRESET', 'ETIMEDOUT'].includes(err.code)) {
			console.log('Recreating database connection.');
			setTimeout(dbConnect, 2000);
		}
		else {
			console.error('Non-recoverable database error:', err.code);
		}
	});

	con.connect((err) => {
		if (err) {
			console.error('Database connection failed, retrying in 5s:', err);
			setTimeout(dbConnect, 5000);
		}
		else {
			console.log('Connected to database.');
		}
	});
}

dbConnect();

// Use a getter so db.con always returns the current connection object,
// even after dbConnect() has reassigned con during a reconnect.
module.exports = {
	get con() { return con; },
};
