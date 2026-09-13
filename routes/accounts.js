// routes/accounts.js
// Create accounts and look up an account's current state (balance + tier).

const express = require('express');
const db = require('../db');
const { getBalance, trailingTwelveMonthLitres, fleetTierForLitres, AppError } = require('../services/rewardEngine');
const { createAccount } = require('../services/accountService');
const { getRedeemable } = require('../services/redemptionEngine');
const { listVehicles } = require('../services/vehicleService');

const router = express.Router();

// POST /api/accounts — open a new card, individual or fleet.
// This is where "individual vs fleet, decided at onboarding" (never a
// threshold) actually happens: whoever's registering the card just picks
// the type here, once, and it never changes automatically. The card code
// is generated server-side (see services/accountService.js) — never typed
// in — and the phone must already be OTP-verified (services/otpService.js).
router.post('/', (req, res) => {
  try {
    const { type, name, phone, vehicleType, organisationName, location, contactPersonName, contactPersonPhone } = req.body;
    const accountId = createAccount({ type, name, phone, vehicleType, organisationName, location, contactPersonName, contactPersonPhone });
    res.status(201).json(getAccountView(accountId));
  } catch (err) {
    if (err instanceof AppError) return res.status(err.status).json({ error: err.message });
    throw err;
  }
});

// GET /api/accounts/by-code/:code — same as above, but looked up by the
// physical card code instead of the internal numeric ID. This is what the
// pump/portal UI actually uses, since staff read the code off the card,
// not a database ID.
router.get('/by-code/:code', (req, res) => {
  const account = db.prepare('SELECT * FROM accounts WHERE card_code = ?').get(req.params.code);
  if (!account) return res.status(404).json({ error: 'No account found for that card code' });
  res.json(getAccountView(account.id));
});

// GET /api/accounts/by-phone/:phone — same, but looked up by the phone
// number on file. Lets the "Find account" screen accept either a card
// code or a phone number from a single box.
router.get('/by-phone/:phone', (req, res) => {
  const account = db.prepare('SELECT * FROM accounts WHERE phone = ?').get(req.params.phone);
  if (!account) return res.status(404).json({ error: 'No account found for that phone number' });
  res.json(getAccountView(account.id));
});

// GET /api/accounts/:id — current balance, and current tier if it's a fleet account.
router.get('/:id', (req, res) => {
  const view = getAccountView(req.params.id);
  if (!view) return res.status(404).json({ error: 'Account not found' });
  res.json(view);
});

// GET /api/accounts/:id/redeemable?invoiceAmount=X — the same 500-min /
// 30%-cap rules redeem() enforces, previewed with no writes, so the Redeem
// screen can show the ceiling before the customer types a number.
router.get('/:id/redeemable', (req, res) => {
  try {
    const invoiceAmount = Number(req.query.invoiceAmount);
    if (!req.query.invoiceAmount || Number.isNaN(invoiceAmount)) {
      return res.status(400).json({ error: 'invoiceAmount query parameter is required' });
    }
    const result = getRedeemable({ accountId: req.params.id, invoiceAmount });
    res.json(result);
  } catch (err) {
    if (err instanceof AppError) return res.status(err.status).json({ error: err.message });
    throw err;
  }
});

// GET /api/accounts/:id/vehicles — a fleet's registered vehicles, for the
// staff console's Fuel & Earn screen to offer as an (optional) picker.
router.get('/:id/vehicles', (req, res) => {
  res.json(listVehicles(req.params.id));
});

// GET /api/accounts/:id/transactions — full fuel + redemption history, most recent first.
router.get('/:id/transactions', (req, res) => {
  const accountId = req.params.id;
  const fuel = db.prepare(`SELECT *, 'fuel' AS kind FROM fuel_transactions WHERE account_id = ?`).all(accountId);
  const redemptions = db.prepare(`SELECT *, 'redemption' AS kind FROM redemptions WHERE account_id = ? AND status = 'approved'`).all(accountId);
  const combined = [...fuel, ...redemptions].sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
  res.json(combined);
});

function getAccountView(accountId) {
  const account = db.prepare('SELECT * FROM accounts WHERE id = ?').get(accountId);
  if (!account) return null;
  const balance = getBalance(accountId);

  let tierInfo = null;
  if (account.type === 'fleet') {
    const litres = trailingTwelveMonthLitres(accountId);
    const tier = fleetTierForLitres(litres);
    tierInfo = { trailingLitres: litres, currentRate: tier.rate, tierFloor: tier.min };
  }

  return { ...account, balance, tier: tierInfo };
}

module.exports = router;
