// server.js
// Wires everything together and starts the server. This is the file you
// run — everything else is imported from here or from the route files.

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');

const { requireApiKey } = require('./services/auth');
const accountsRoute = require('./routes/accounts');
const fuelRoute = require('./routes/fuel');
const redeemRoute = require('./routes/redeem');
const analyticsRoute = require('./routes/analytics');

const app = express();
app.use(cors());
app.use(express.json());

// Serve the portal (staff console + customer/fleet views) as static files.
app.use(express.static(path.join(__dirname, 'public')));

// Reads (looking up an account, its history, analytics) are open — this is
// what the customer/fleet portal itself calls. Writes (creating an account,
// recording fuel, redeeming) require the staff API key — these are the
// pump-attendant / back-office actions, not something a customer should be
// able to trigger from their own phone.
app.use('/api/accounts', (req, res, next) => (req.method === 'GET' ? next() : requireApiKey(req, res, next)), accountsRoute);
app.use('/api/fuel', requireApiKey, fuelRoute);
app.use('/api/redeem', requireApiKey, redeemRoute);
app.use('/api/analytics', analyticsRoute);

app.get('/api/health', (req, res) => res.json({ ok: true, service: 'hass-nation-system' }));

// Generic error handler — so an unexpected bug returns a clean JSON error
// instead of crashing the server or leaking a stack trace to the client.
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'Internal server error' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`HASS NATION system running at http://localhost:${PORT}`);
  console.log(`Staff API key: ${process.env.STAFF_API_KEY || 'dev-key-change-me'} (send as x-api-key header)`);
});
