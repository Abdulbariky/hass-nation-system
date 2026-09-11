// routes/accounts.js
// Create accounts and look up an account's current state (balance + tier).

const express = require('express');
const db = require('../db');
const { getBalance, trailingTwelveMonthLitres, fleetTierForLitres } = require('../services/rewardEngine');

const router = express.Router();

// POST /api/accounts — open a new card, individual or fleet.
// This is where "individual vs fleet, decided at onboarding" (never a
// threshold) actually happens: whoever's registering the card just picks
// the type here, once, and it never changes automatically.
router.post('/', (req, res) => {
  const { cardCode, type, name, phone, rank } = req.body;
  if (!cardCode || !type || !name) {
    return res.status(400).json({ error: 'cardCode, type, and name are required' });
  }
  if (!['individual', 'fleet'].includes(type)) {
    return res.status(400).json({ error: "type must be 'individual' or 'fleet'" });
  }
  try {
    const result = db.prepare(`
      INSERT INTO accounts (card_code, type, name, phone, rank)
      VALUES (@cardCode, @type, @name, @phone, @rank)
    `).run({ cardCode, type, name, phone: phone || null, rank: rank || null });
    res.status(201).json(getAccountView(result.lastInsertRowid));
  } catch (err) {
    if (String(err.message).includes('UNIQUE constraint failed')) {
      return res.status(409).json({ error: 'A card with that code already exists' });
    }
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

// GET /api/accounts/:id — current balance, and current tier if it's a fleet account.
router.get('/:id', (req, res) => {
  const view = getAccountView(req.params.id);
  if (!view) return res.status(404).json({ error: 'Account not found' });
  res.json(view);
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
