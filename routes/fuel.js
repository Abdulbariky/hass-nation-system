// routes/fuel.js
// The "Fuel & Earn" step — pump attendant records a fill-up, the reward
// engine calculates and credits points automatically.

const express = require('express');
const { recordFuelPurchase, previewEarn, AppError } = require('../services/rewardEngine');
const { sendSms } = require('../services/smsService');
const db = require('../db');

const router = express.Router();

// GET /api/fuel/preview — "this will earn X points at Y points/litre",
// computed with the exact same reward-engine logic recordFuelPurchase
// uses (including a fleet's CURRENT tier), but writes nothing.
router.get('/preview', (req, res) => {
  try {
    const { accountId, litres } = req.query;
    if (!accountId || litres == null) {
      return res.status(400).json({ error: 'accountId and litres are required' });
    }
    const result = previewEarn({ accountId, litres });
    res.json(result);
  } catch (err) {
    if (err instanceof AppError) return res.status(err.status).json({ error: err.message });
    throw err;
  }
});

router.post('/', async (req, res) => {
  try {
    const { accountId, litres, fuelType, station, amountKsh, vehicleId } = req.body;
    if (!accountId || !litres || !fuelType || amountKsh == null) {
      return res.status(400).json({ error: 'accountId, litres, fuelType, and amountKsh are required' });
    }
    const result = recordFuelPurchase({ accountId, litres: Number(litres), fuelType, station, amountKsh: Number(amountKsh), staffId: req.staff.id, vehicleId: vehicleId || null });

    const account = db.prepare('SELECT * FROM accounts WHERE id = ?').get(accountId);
    await sendSms(account.phone, `HASS NATION: You earned ${Math.round(result.pointsEarned)} points today. Balance: ${Math.round(result.newBalance)} points.`);

    res.status(201).json(result);
  } catch (err) {
    if (err instanceof AppError) return res.status(err.status).json({ error: err.message });
    throw err;
  }
});

module.exports = router;
