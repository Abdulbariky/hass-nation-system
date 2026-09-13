// scripts/simulateMpesaCallback.js
//
// Simulates Safaricom's Daraja STK Push callback hitting our own webhook —
// for exercising the M-Pesa top-up flow end-to-end on a laptop with no
// real M-Pesa account, shortcode, or public URL. This is ONLY meaningful
// while MPESA_MOCK=true (the default) — see README "M-Pesa top-up".
//
// Usage:
//   node scripts/simulateMpesaCallback.js <checkoutRequestId> [--fail]
//
// The checkoutRequestId comes back from POST /api/mpesa/stkpush (also
// shown in the console's Top-up screen after sending a push).

const { simulateCallback, MPESA_MOCK } = require('../services/mpesaService');

const [, , checkoutRequestId, flag] = process.argv;

if (!checkoutRequestId) {
  console.error('Usage: node scripts/simulateMpesaCallback.js <checkoutRequestId> [--fail]');
  process.exit(1);
}

if (!MPESA_MOCK) {
  console.error('MPESA_MOCK is not enabled — this script only makes sense against a mocked top-up. Set MPESA_MOCK=true in .env.');
  process.exit(1);
}

try {
  const result = simulateCallback({ checkoutRequestId, succeed: flag !== '--fail' });
  console.log('Simulated callback processed:', result);
} catch (err) {
  console.error('Could not simulate callback:', err.message);
  process.exit(1);
}
