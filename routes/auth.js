// routes/auth.js
// Staff login/logout and "who am I" — the only endpoints that don't
// themselves require an existing session (login is how you get one).

const express = require('express');
const { login, logout, requireStaffAuth, tokenFromRequest } = require('../services/auth');
const { AppError } = require('../services/rewardEngine');

const router = express.Router();

router.post('/login', (req, res) => {
  try {
    const { identifier, password } = req.body;
    const result = login(identifier, password);
    res.json(result);
  } catch (err) {
    if (err instanceof AppError) return res.status(err.status).json({ error: err.message });
    throw err;
  }
});

router.post('/logout', (req, res) => {
  logout(tokenFromRequest(req));
  res.json({ ok: true });
});

router.get('/me', requireStaffAuth, (req, res) => {
  res.json({ staff: req.staff });
});

module.exports = router;
