// routes/ussd.js
// The endpoint a USSD gateway (Africa's Talking, or Safaricom's own USSD
// product / an aggregator fronting a Safaricom-leased shortcode) calls on
// every key-press in a session. Public and unauthenticated by convention —
// the gateway is the only thing that ever calls it, identified by the
// phoneNumber it reports for the session, not a bearer token. See
// services/ussdService.js and README "USSD balance check" for what this
// still needs (a real leased shortcode) before a phone can reach it.

const express = require('express');
const { handleUssdRequest } = require('../services/ussdService');

const router = express.Router();

router.post('/', (req, res) => {
  const { phoneNumber, text } = req.body;
  const response = handleUssdRequest({ phoneNumber, text: text || '' });
  res.set('Content-Type', 'text/plain');
  res.send(response);
});

module.exports = router;
