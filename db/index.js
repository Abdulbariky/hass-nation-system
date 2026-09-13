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

// CREATE TABLE IF NOT EXISTS above handles brand-new databases, but a
// database file created before this column existed needs it added by hand —
// SQLite's ALTER TABLE has no "ADD COLUMN IF NOT EXISTS", so we check first.
function ensureColumn(table, column, ddl) {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name);
  if (!columns.includes(column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
  }
}

ensureColumn('accounts', 'vehicle_type', 'vehicle_type TEXT');
ensureColumn('accounts', 'organisation_name', 'organisation_name TEXT');
ensureColumn('accounts', 'location', 'location TEXT');
ensureColumn('accounts', 'contact_person_name', 'contact_person_name TEXT');
ensureColumn('accounts', 'contact_person_phone', 'contact_person_phone TEXT');
ensureColumn('fuel_transactions', 'staff_id', 'staff_id INTEGER REFERENCES staff_users(id)');
ensureColumn('redemptions', 'staff_id', 'staff_id INTEGER REFERENCES staff_users(id)');
ensureColumn('fuel_transactions', 'vehicle_id', 'vehicle_id INTEGER REFERENCES vehicles(id)');

module.exports = db;
