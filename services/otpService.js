// services/otpService.js
//
// Phone verification via a 6-digit code before an account can be created.
// Sends through services/smsService.js — with SMS_PROVIDER=console (the
// default), the code just prints to the terminal, which is what we want
// for local development.

const db = require('../db');
const { sendSms } = require('./smsService');
const { AppError } = require('./rewardEngine');

const CODE_LENGTH = 6;
const EXPIRY_MINUTES = 5;
const MAX_ATTEMPTS_PER_HOUR = 5;
const VERIFIED_WINDOW_MINUTES = 30; // how long a successful verification stays usable for account creation

function generateCode() {
  return String(Math.floor(Math.random() * 10 ** CODE_LENGTH)).padStart(CODE_LENGTH, '0');
}

// Every verify attempt against any code this phone has been issued in the
// trailing hour — right or wrong — counts toward the cap. This is what
// stops someone brute-forcing a 6-digit code no matter how many codes
// they've had sent to them.
function attemptsInLastHour(phone) {
  const row = db.prepare(`
    SELECT COALESCE(SUM(attempts), 0) AS total
    FROM otp_verifications
    WHERE phone = ? AND created_at >= datetime('now', '-1 hour')
  `).get(phone);
  return row.total;
}

/** Generates a code, stores it, and sends it. The one function that should ever issue an OTP. */
async function sendOtp(phone) {
  if (!phone) throw new AppError(400, 'phone is required');

  const code = generateCode();
  db.prepare(`
    INSERT INTO otp_verifications (phone, code, expires_at)
    VALUES (?, ?, datetime('now', '+${EXPIRY_MINUTES} minutes'))
  `).run(phone, code);

  await sendSms(phone, `HASS NATION: your verification code is ${code}. It expires in ${EXPIRY_MINUTES} minutes.`);
  return { sent: true };
}

/** Checks a code against the most recently issued OTP for this phone. */
function verifyOtp(phone, code) {
  if (!phone || !code) throw new AppError(400, 'phone and code are required');

  if (attemptsInLastHour(phone) >= MAX_ATTEMPTS_PER_HOUR) {
    throw new AppError(429, 'Too many verification attempts for this phone — try again in an hour');
  }

  const row = db.prepare(`
    SELECT *, (expires_at <= datetime('now')) AS is_expired
    FROM otp_verifications
    WHERE phone = ?
    ORDER BY id DESC
    LIMIT 1
  `).get(phone);

  if (!row) throw new AppError(400, 'No verification code was sent to this phone');

  db.prepare(`UPDATE otp_verifications SET attempts = attempts + 1 WHERE id = ?`).run(row.id);

  if (row.consumed) throw new AppError(400, 'This code has already been used — request a new one');
  if (row.is_expired) throw new AppError(400, 'This code has expired — request a new one');
  if (String(row.code) !== String(code)) throw new AppError(400, 'Incorrect code');

  db.prepare(`UPDATE otp_verifications SET consumed = 1 WHERE id = ?`).run(row.id);
  return { verified: true };
}

/** Has this phone completed a verification recently enough to open an account? */
function isPhoneVerified(phone) {
  const row = db.prepare(`
    SELECT 1 FROM otp_verifications
    WHERE phone = ? AND consumed = 1 AND created_at >= datetime('now', '-${VERIFIED_WINDOW_MINUTES} minutes')
    ORDER BY id DESC LIMIT 1
  `).get(phone);
  return !!row;
}

module.exports = {
  sendOtp,
  verifyOtp,
  isPhoneVerified,
  CODE_LENGTH,
  EXPIRY_MINUTES,
  MAX_ATTEMPTS_PER_HOUR,
  VERIFIED_WINDOW_MINUTES,
};
