// server.js
// Wires everything together and starts the server. This is the file you
// run — everything else is imported from here or from the route files.

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');

const { requireStaffAuth } = require('./services/auth');
const authRoute = require('./routes/auth');
const accountsRoute = require('./routes/accounts');
const fuelRoute = require('./routes/fuel');
const redeemRoute = require('./routes/redeem');
const analyticsRoute = require('./routes/analytics');
const otpRoute = require('./routes/otp');
const configRoute = require('./routes/config');
const fleetRoute = require('./routes/fleet');
const mpesaRoute = require('./routes/mpesa');
const ussdRoute = require('./routes/ussd');

const app = express();
app.use(cors());
app.use(express.json());
// USSD gateways (Africa's Talking / Safaricom) POST form-encoded, not JSON.
app.use(express.urlencoded({ extended: true }));

// Serve the portal (welcome page, login, staff console) as static files.
app.use(express.static(path.join(__dirname, 'public')));

// /api/auth/login and /api/auth/logout are the only endpoints that don't
// require an existing session — that's how you get one. Everything else
// is a staff action and requires a logged-in session (services/auth.js) —
// no more single shared password, every write is tied to WHO made it.
app.use('/api/auth', authRoute);
app.use('/api/accounts', requireStaffAuth, accountsRoute);
app.use('/api/fuel', requireStaffAuth, fuelRoute);
app.use('/api/redeem', requireStaffAuth, redeemRoute);
app.use('/api/analytics', requireStaffAuth, analyticsRoute);
app.use('/api/otp', requireStaffAuth, otpRoute);
app.use('/api/config', requireStaffAuth, configRoute);

// /api/fleet is a completely separate login system (fleet manager, phone +
// OTP, no staff involved) — its own auth is applied per-route inside
// routes/fleet.js, not at this mount level.
app.use('/api/fleet', fleetRoute);

// /api/mpesa — Safaricom Daraja STK Push top-up. NOT LIVE without real
// Daraja credentials and a public callback URL (see .env.example and
// README "M-Pesa top-up"). Staff-facing routes self-gate with
// requireStaffAuth inside routes/mpesa.js; the Safaricom callback route
// stays public (protected instead by a secret path segment) since
// Safaricom cannot present a staff session.
app.use('/api/mpesa', mpesaRoute);

// /api/ussd — the endpoint a leased USSD shortcode would point at. NOT
// LIVE without one (see README "USSD balance check"). Public by
// convention, like the M-Pesa callback — the gateway is the only caller.
app.use('/api/ussd', ussdRoute);

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
  console.log('Staff must log in — run "npm run create-admin" if there is no admin user yet.');
});
