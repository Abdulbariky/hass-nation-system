// services/fleetAuthService.js
//
// Login for a fleet account's contact person — phone + OTP (reusing
// services/otpService.js exactly as built for account creation), never a
// password. A session here is bound to exactly one accounts.id, decided
// ONCE at login time from whichever fleet account the verified phone
// belongs to. Every fleet-dashboard route trusts ONLY that bound
// account_id (req.fleetAccountId) — never an accountId the client sends —
// which is what makes it impossible for one fleet manager to see another
// fleet's data.

const crypto = require('crypto');
const db = require('../db');
const { AppError } = require('./rewardEngine');
const { sendOtp, verifyOtp } = require('./otpService');

const SESSION_TTL_HOURS = 12;

/** A fleet account is reachable by its main phone or its contact person's phone. */
function findFleetAccountByPhone(phone) {
  return db.prepare(`
    SELECT * FROM accounts
    WHERE type = 'fleet' AND (phone = ? OR contact_person_phone = ?)
  `).get(phone, phone);
}

async function requestLogin(phone) {
  if (!phone) throw new AppError(400, 'phone is required');
  const account = findFleetAccountByPhone(phone);
  if (!account) throw new AppError(404, 'No fleet account found for that phone number');
  await sendOtp(phone);
  return { sent: true };
}

function confirmLogin(phone, code) {
  if (!phone || !code) throw new AppError(400, 'phone and code are required');
  const account = findFleetAccountByPhone(phone);
  if (!account) throw new AppError(404, 'No fleet account found for that phone number');

  verifyOtp(phone, code); // throws AppError on a bad/expired/reused/rate-limited code

  const token = crypto.randomBytes(32).toString('hex');
  db.prepare(`
    INSERT INTO fleet_sessions (token, account_id, phone, expires_at)
    VALUES (?, ?, ?, datetime('now', '+${SESSION_TTL_HOURS} hours'))
  `).run(token, account.id, phone);

  return { token, account };
}

function logout(token) {
  if (!token) return;
  db.prepare(`DELETE FROM fleet_sessions WHERE token = ?`).run(token);
}

/** The still-valid account_id behind a session token, or null. */
function getAccountIdForToken(token) {
  if (!token) return null;
  const row = db.prepare(`
    SELECT account_id FROM fleet_sessions
    WHERE token = ? AND expires_at > datetime('now')
  `).get(token);
  return row ? row.account_id : null;
}

function tokenFromRequest(req) {
  const header = req.header('authorization') || '';
  return header.startsWith('Bearer ') ? header.slice(7) : null;
}

/** Route middleware: sets req.fleetAccountId from the session — routes must never trust a client-supplied accountId instead. */
function requireFleetAuth(req, res, next) {
  const accountId = getAccountIdForToken(tokenFromRequest(req));
  if (!accountId) return res.status(401).json({ error: 'Login required' });
  req.fleetAccountId = accountId;
  next();
}

module.exports = {
  findFleetAccountByPhone,
  requestLogin,
  confirmLogin,
  logout,
  getAccountIdForToken,
  tokenFromRequest,
  requireFleetAuth,
};
