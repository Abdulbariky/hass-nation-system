// routes/mpesa.js
// M-Pesa top-up via Safaricom Daraja STK Push. See services/mpesaService.js
// and the README's "M-Pesa top-up" section for exactly what's real vs
// mocked, and what credentials this still needs before it moves real money.

const express = require('express');
const { initiateStkPush, handleCallback, simulateCallback, getStatus, MPESA_MOCK } = require('../services/mpesaService');
const { AppError } = require('../services/rewardEngine');
const { requireStaffAuth } = require('../services/auth');

const router = express.Router();

// Staff-initiated from the console — same session requirement as recording
// a fuel purchase or a redemption.
router.post('/stkpush', requireStaffAuth, async (req, res) => {
  try {
    const { accountId, phone, amount } = req.body;
    const result = await initiateStkPush({ accountId, phone, amount: Number(amount) });
    res.status(201).json(result);
  } catch (err) {
    if (err instanceof AppError) return res.status(err.status).json({ error: err.message });
    throw err;
  }
});

router.get('/status/:checkoutRequestId', requireStaffAuth, (req, res) => {
  try {
    res.json(getStatus(req.params.checkoutRequestId));
  } catch (err) {
    if (err instanceof AppError) return res.status(err.status).json({ error: err.message });
    throw err;
  }
});

// Lets the console resolve a mocked top-up without a real Safaricom
// callback ever arriving. Refuses outright unless MPESA_MOCK=true, so
// this can never be used to fabricate a real payment.
router.post('/simulate-callback', requireStaffAuth, (req, res) => {
  try {
    if (!MPESA_MOCK) {
      return res.status(400).json({ error: 'Simulation is only available when MPESA_MOCK=true' });
    }
    const { checkoutRequestId, succeed } = req.body;
    const result = simulateCallback({ checkoutRequestId, succeed: succeed !== false });
    res.json(result);
  } catch (err) {
    if (err instanceof AppError) return res.status(err.status).json({ error: err.message });
    throw err;
  }
});

// ---- Safaricom calls THIS — no staff session (Safaricom can't present
// one), so it's protected instead by a secret path segment. Generate one
// with: node -e "console.log(require('crypto').randomBytes(24).toString('hex'))"
// and put it in MPESA_CALLBACK_SECRET and the tail of MPESA_CALLBACK_URL.
// In production, also restrict this route to Safaricom's published
// callback IP ranges at the network/firewall level — a secret URL alone
// is a reasonable local safeguard, not a complete one. ----
router.post('/callback/:secret', (req, res) => {
  const expected = process.env.MPESA_CALLBACK_SECRET || 'REPLACE_WITH_RANDOM_SECRET';
  if (req.params.secret !== expected) {
    return res.status(404).end(); // don't confirm the real endpoint even exists
  }
  try {
    const result = handleCallback(req.body);
    res.json({ ResultCode: 0, ResultDesc: 'Accepted', ...result });
  } catch (err) {
    console.error('M-Pesa callback error:', err.message);
    // Daraja retries the callback on anything other than a 200/ResultCode 0
    // response, which would just repeat the same failure forever. Log it
    // and acknowledge — see mpesa_transactions for the actual outcome.
    res.json({ ResultCode: 0, ResultDesc: 'Accepted' });
  }
});

module.exports = router;
