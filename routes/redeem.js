// routes/redeem.js
// The redemption step — validates against the 500-min / 30%-cap rules
// and either applies the discount or explains why it can't.

const express = require('express');
const { redeem } = require('../services/redemptionEngine');
const { AppError } = require('../services/rewardEngine');
const { sendSms } = require('../services/smsService');
const db = require('../db');

const router = express.Router();

router.post('/', async (req, res) => {
  try {
    const { accountId, invoiceAmount, pointsRequested } = req.body;
    if (!accountId || invoiceAmount == null || pointsRequested == null) {
      return res.status(400).json({ error: 'accountId, invoiceAmount, and pointsRequested are required' });
    }
    const result = redeem({ accountId, invoiceAmount: Number(invoiceAmount), pointsRequested: Number(pointsRequested), staffId: req.staff.id });

    const account = db.prepare('SELECT * FROM accounts WHERE id = ?').get(accountId);
    if (result.status === 'approved') {
      await sendSms(account.phone, `HASS NATION: ${Math.round(result.discountKsh)} points redeemed. New total: KSh ${Math.round(result.newInvoiceTotal)}. Balance: ${Math.round(result.newBalance)} points.`);
    }

    const httpStatus = result.status === 'approved' ? 200 : 422;
    res.status(httpStatus).json(result);
  } catch (err) {
    if (err instanceof AppError) return res.status(err.status).json({ error: err.message });
    throw err;
  }
});

module.exports = router;
