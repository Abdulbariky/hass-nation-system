// routes/config.js
// Read-only config the frontend needs but shouldn't hardcode — currently
// just the pump prices used for the litres <-> amount auto-calculation.

const express = require('express');
const { getPumpPrices } = require('../services/pumpPriceService');

const router = express.Router();

router.get('/prices', (req, res) => {
  res.json(getPumpPrices());
});

module.exports = router;
