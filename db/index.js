// db/index.js
// Opens (or creates) the SQLite file and makes sure the schema exists.
// Every other file in the project imports `db` from here — one shared
// connection, so we never have two files talking to two different databases.

const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'hass_nation.db');
const db = new Database(DB_PATH);

db.pragma('journal_mode = WAL'); // safer for concurrent reads/writes than the default

const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
db.exec(schema);

module.exports = db;
