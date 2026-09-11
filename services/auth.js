// services/auth.js
//
// HONEST NOTE, not hidden in a comment nobody reads:
// This is a single shared API key for the whole staff/POS side — good
// enough to stop a random person on the internet from hitting your API,
// NOT good enough for real pilot use with actual pump staff and real
// money. Before you go live at a station, replace this with per-station
// or per-attendant logins so you know WHO ran every transaction, not just
// that "someone with the key" did. Flagging this now so it doesn't get
// forgotten later.

require('dotenv').config();

const API_KEY = process.env.STAFF_API_KEY || 'dev-key-change-me';

function requireApiKey(req, res, next) {
  const key = req.header('x-api-key');
  if (key !== API_KEY) {
    return res.status(401).json({ error: 'Missing or invalid x-api-key header' });
  }
  next();
}

module.exports = { requireApiKey };
