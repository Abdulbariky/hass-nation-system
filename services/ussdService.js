// services/ussdService.js
//
// USSD menu logic — check points balance, and recent transactions, by
// phone. Speaks the request/response convention Africa's Talking's USSD
// product uses (and which Safaricom's own USSD gateway/aggregators mirror):
// the gateway POSTs sessionId/phoneNumber/text on every key-press, and
// expects back a plain-text response starting with "CON " (show this,
// then keep prompting) or "END " (final screen, session over).
//
// ============================================================
// THIS CANNOT BE FULLY TESTED LOCALLY. An actual USSD shortcode (e.g.
// *384*something#) has to be LEASED FROM SAFARICOM — a paid, approval-
// gated process that typically takes several weeks — and pointed at this
// route's public URL before a real phone can dial in. Until then, use
// scripts/simulateUssd.js to drive this exact menu logic over HTTP,
// exactly as the real gateway would. See README "USSD balance check".
// ============================================================

const db = require('../db');
const { getBalance } = require('./rewardEngine');

const RECENT_TRANSACTIONS_LIMIT = 5;

function findAccountByPhone(phone) {
  return db.prepare('SELECT * FROM accounts WHERE phone = ?').get(phone);
}

function con(message) { return `CON ${message}`; }
function end(message) { return `END ${message}`; }

/**
 * `text` is the FULL accumulated input for this USSD session, star-
 * separated (e.g. "" on the very first request, "1" after picking menu
 * option 1, "2*1" for a submenu choice) — that's the convention: the
 * gateway holds no state itself, so it resends everything typed so far
 * on every single request, and we just look at the newest step.
 */
function handleUssdRequest({ phoneNumber, text }) {
  const steps = (text || '').split('*').filter(Boolean);

  if (steps.length === 0) {
    return con('Welcome to HASS NATION\n1. Check points balance\n2. Recent transactions');
  }

  const account = findAccountByPhone(phoneNumber);
  if (!account) {
    return end(`No HASS NATION account found for ${phoneNumber}.`);
  }

  if (steps[0] === '1') {
    const balance = getBalance(account.id);
    return end(`Your HASS NATION balance is ${Math.round(balance)} points.`);
  }

  if (steps[0] === '2') {
    const rows = db.prepare(`
      SELECT created_at, points_earned AS points FROM fuel_transactions WHERE account_id = ?
      UNION ALL
      SELECT created_at, -points_requested AS points FROM redemptions WHERE account_id = ? AND status = 'approved'
      ORDER BY created_at DESC
      LIMIT ?
    `).all(account.id, account.id, RECENT_TRANSACTIONS_LIMIT);

    if (!rows.length) return end('No transactions yet.');

    const lines = rows.map(r => {
      const date = r.created_at.slice(0, 10);
      const sign = r.points >= 0 ? '+' : '';
      return `${date} ${sign}${Math.round(r.points)}`;
    });
    return end(`Recent activity:\n${lines.join('\n')}`);
  }

  return end('Invalid choice.');
}

module.exports = { handleUssdRequest, RECENT_TRANSACTIONS_LIMIT };
