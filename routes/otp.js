// routes/otp.js
// Phone verification for the new-account signup flow — send a code, then
// verify it. See services/otpService.js for the actual rules.

const express = require('express');
const { sendOtp, verifyOtp } = require('../services/otpService');
const { AppError } = require('../services/rewardEngine');

const router = express.Router();

router.post('/send', async (req, res) => {
  try {
    const { phone } = req.body;
    const result = await sendOtp(phone);
    res.status(201).json(result);
  } catch (err) {
    if (err instanceof AppError) return res.status(err.status).json({ error: err.message });
    throw err;
  }
});

router.post('/verify', (req, res) => {
  try {
    const { phone, code } = req.body;
    const result = verifyOtp(phone, code);
    res.json(result);
  } catch (err) {
    if (err instanceof AppError) return res.status(err.status).json({ error: err.message });
    throw err;
  }
});

module.exports = router;
