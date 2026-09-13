// routes/fleet.js
// The fleet manager's own dashboard — separate from the staff console.
// Login is phone + OTP (no staff, no password) and every route below
// requireFleetAuth trusts ONLY req.fleetAccountId, set from the session
// token — never an accountId the client sends. That is the entire
// mechanism that keeps one fleet manager from ever seeing another
// fleet's data; see services/fleetAuthService.js.

const express = require('express');
const db = require('../db');
const { getBalance, trailingTwelveMonthLitres, fleetTierForLitres, AppError } = require('../services/rewardEngine');
const { requestLogin, confirmLogin, logout, tokenFromRequest, requireFleetAuth } = require('../services/fleetAuthService');
const { listVehicles, addVehicle, deactivateVehicle, requireOwnedVehicle } = require('../services/vehicleService');

const router = express.Router();

function publicAccount(account) {
  return {
    id: account.id,
    name: account.name,
    card_code: account.card_code,
    type: account.type,
    organisation_name: account.organisation_name,
    location: account.location,
    contact_person_name: account.contact_person_name,
    contact_person_phone: account.contact_person_phone,
  };
}

// ---- Login (phone + OTP) — the only routes here that don't require a session ----
router.post('/auth/send-otp', async (req, res) => {
  try {
    const result = await requestLogin(req.body.phone);
    res.status(201).json(result);
  } catch (err) {
    if (err instanceof AppError) return res.status(err.status).json({ error: err.message });
    throw err;
  }
});

router.post('/auth/verify-otp', (req, res) => {
  try {
    const { phone, code } = req.body;
    const { token, account } = confirmLogin(phone, code);
    res.json({ token, account: publicAccount(account) });
  } catch (err) {
    if (err instanceof AppError) return res.status(err.status).json({ error: err.message });
    throw err;
  }
});

router.post('/auth/logout', (req, res) => {
  logout(tokenFromRequest(req));
  res.json({ ok: true });
});

// ---- Dashboard (session required from here down) ----
router.get('/dashboard', requireFleetAuth, (req, res) => {
  const account = db.prepare('SELECT * FROM accounts WHERE id = ?').get(req.fleetAccountId);
  const balance = getBalance(req.fleetAccountId);
  const litres = trailingTwelveMonthLitres(req.fleetAccountId);
  const tier = fleetTierForLitres(litres);
  res.json({
    account: publicAccount(account),
    balance,
    tier: { trailingLitres: litres, currentRate: tier.rate, tierFloor: tier.min },
  });
});

router.get('/vehicles', requireFleetAuth, (req, res) => {
  res.json(listVehicles(req.fleetAccountId));
});

router.post('/vehicles', requireFleetAuth, (req, res) => {
  try {
    const { registrationNumber, vehicleType, driverName, driverPhone } = req.body;
    const vehicle = addVehicle({ accountId: req.fleetAccountId, registrationNumber, vehicleType, driverName, driverPhone });
    res.status(201).json(vehicle);
  } catch (err) {
    if (err instanceof AppError) return res.status(err.status).json({ error: err.message });
    throw err;
  }
});

router.post('/vehicles/:id/deactivate', requireFleetAuth, (req, res) => {
  try {
    const vehicle = deactivateVehicle(req.params.id, req.fleetAccountId);
    res.json(vehicle);
  } catch (err) {
    if (err instanceof AppError) return res.status(err.status).json({ error: err.message });
    throw err;
  }
});

// GET /api/fleet/vehicles/:id/transactions — requireOwnedVehicle throws a
// 404 (not the vehicle's actual account) if it belongs to a different
// fleet, so an id guessed from another account's vehicle reveals nothing.
router.get('/vehicles/:id/transactions', requireFleetAuth, (req, res) => {
  try {
    requireOwnedVehicle(req.params.id, req.fleetAccountId);
    const rows = db.prepare(`SELECT * FROM fuel_transactions WHERE vehicle_id = ? ORDER BY created_at DESC`).all(req.params.id);
    res.json(rows);
  } catch (err) {
    if (err instanceof AppError) return res.status(err.status).json({ error: err.message });
    throw err;
  }
});

module.exports = router;
