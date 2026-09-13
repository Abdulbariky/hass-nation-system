// services/auth.js
//
// Replaces the old single shared API key. Every staff member now has their
// own login (staff_users), and every session is a bearer token tied to
// exactly one of them (staff_sessions) — so every write anyone makes can
// be traced back to WHO made it, not just "someone with the password."

const crypto = require('crypto');
const bcrypt = require('bcrypt');
const db = require('../db');
const { AppError } = require('./rewardEngine');

const SESSION_TTL_HOURS = 12;

function hashPassword(password) {
  return bcrypt.hashSync(password, 10);
}

function verifyPassword(password, hash) {
  return bcrypt.compareSync(password, hash);
}

/** Strips password_hash out before this ever reaches a client. */
function publicStaff(staff) {
  return { id: staff.id, name: staff.name, phone: staff.phone, email: staff.email, role: staff.role, station: staff.station };
}

function createSession(staffId) {
  const token = crypto.randomBytes(32).toString('hex');
  db.prepare(`
    INSERT INTO staff_sessions (token, staff_id, expires_at)
    VALUES (?, ?, datetime('now', '+${SESSION_TTL_HOURS} hours'))
  `).run(token, staffId);
  return token;
}

/** Logs a staff member in by phone OR email + password. Throws on any mismatch — never reveals which part was wrong. */
function login(identifier, password) {
  if (!identifier || !password) throw new AppError(400, 'identifier and password are required');

  const staff = db.prepare(`SELECT * FROM staff_users WHERE phone = ? OR email = ?`).get(identifier, identifier);
  if (!staff || !verifyPassword(password, staff.password_hash)) {
    throw new AppError(401, 'Invalid phone/email or password');
  }

  const token = createSession(staff.id);
  return { token, staff: publicStaff(staff) };
}

function logout(token) {
  if (!token) return;
  db.prepare(`DELETE FROM staff_sessions WHERE token = ?`).run(token);
}

/** Looks up the still-valid staff member behind a session token, or null. */
function getStaffForToken(token) {
  if (!token) return null;
  const staff = db.prepare(`
    SELECT su.* FROM staff_sessions ss
    JOIN staff_users su ON su.id = ss.staff_id
    WHERE ss.token = ? AND ss.expires_at > datetime('now')
  `).get(token);
  return staff || null;
}

function tokenFromRequest(req) {
  const header = req.header('authorization') || '';
  return header.startsWith('Bearer ') ? header.slice(7) : null;
}

/** Route middleware: no valid session, no access. Sets req.staff for handlers that need to record WHO acted. */
function requireStaffAuth(req, res, next) {
  const staff = getStaffForToken(tokenFromRequest(req));
  if (!staff) return res.status(401).json({ error: 'Login required' });
  req.staff = publicStaff(staff);
  next();
}

module.exports = {
  requireStaffAuth,
  login,
  logout,
  getStaffForToken,
  tokenFromRequest,
  hashPassword,
  verifyPassword,
  publicStaff,
};
