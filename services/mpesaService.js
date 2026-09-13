// services/mpesaService.js
//
// M-Pesa STK Push ("Lipa na M-Pesa Online") via Safaricom Daraja, for
// topping up an account's points balance directly with cash — separate
// from earning points at the pump.
//
// ============================================================
// THIS CANNOT BE FULLY TESTED LOCALLY. Before this moves real money:
//   1. An approved Daraja app with PRODUCTION credentials — consumer key,
//      consumer secret, shortcode, and passkey (sandbox credentials only
//      simulate M-Pesa; they don't reach a real phone). Get these from
//      https://developer.safaricom.co.ke after Safaricom approves your
//      go-live application.
//   2. A publicly reachable HTTPS callback URL (MPESA_CALLBACK_URL) that
//      Safaricom's servers can reach from the internet — this CANNOT be
//      localhost. Use a tool like ngrok while integration-testing against
//      the Daraja sandbox, and your real deployed domain in production.
// Until both exist, leave MPESA_MOCK=true (the default) — the entire
// flow below (initiate -> "callback" -> points credited) still runs, with
// no network call to Safaricom at all. See README "M-Pesa top-up".
// ============================================================

require('dotenv').config();
const crypto = require('crypto');
const db = require('../db');
const { AppError } = require('./rewardEngine');

const MPESA_ENV = process.env.MPESA_ENV || 'sandbox'; // 'sandbox' | 'production'
const MPESA_MOCK = (process.env.MPESA_MOCK ?? 'true').toString().toLowerCase() === 'true';

const CONSUMER_KEY = process.env.MPESA_CONSUMER_KEY || 'REPLACE_WITH_DARAJA_CONSUMER_KEY';
const CONSUMER_SECRET = process.env.MPESA_CONSUMER_SECRET || 'REPLACE_WITH_DARAJA_CONSUMER_SECRET';
const SHORTCODE = process.env.MPESA_SHORTCODE || 'REPLACE_WITH_SHORTCODE';
const PASSKEY = process.env.MPESA_PASSKEY || 'REPLACE_WITH_DARAJA_PASSKEY';
const CALLBACK_URL = process.env.MPESA_CALLBACK_URL || 'https://REPLACE-WITH-PUBLIC-HTTPS-URL/api/mpesa/callback/REPLACE_WITH_CALLBACK_SECRET';

const BASE_URL = MPESA_ENV === 'production'
  ? 'https://api.safaricom.co.ke'
  : 'https://sandbox.safaricom.co.ke';

const POINTS_PER_KSH = 1; // same 1:1 conversion the rest of the system uses (see rewardEngine.js)

function darajaTimestamp() {
  const d = new Date();
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

function darajaPassword(ts) {
  return Buffer.from(`${SHORTCODE}${PASSKEY}${ts}`).toString('base64');
}

/** OAuth token for the two calls below. Real network call — never used in mock mode. */
async function getAccessToken() {
  const auth = Buffer.from(`${CONSUMER_KEY}:${CONSUMER_SECRET}`).toString('base64');
  const res = await fetch(`${BASE_URL}/oauth/v1/generate?grant_type=client_credentials`, {
    headers: { Authorization: `Basic ${auth}` },
  });
  if (!res.ok) throw new AppError(502, 'Could not authenticate with Daraja — check MPESA_CONSUMER_KEY / MPESA_CONSUMER_SECRET');
  const data = await res.json();
  return data.access_token;
}

/**
 * Initiates an STK push prompt on the customer's phone. In mock mode
 * (default), nothing is sent to Safaricom — a fake pending request is
 * recorded instead, ready for scripts/simulateMpesaCallback.js (or the
 * "Simulate" buttons in the console's Top-up screen) to resolve.
 */
async function initiateStkPush({ accountId, phone, amount }) {
  const account = db.prepare('SELECT * FROM accounts WHERE id = ?').get(accountId);
  if (!account) throw new AppError(404, 'Account not found');
  if (!phone) throw new AppError(400, 'phone is required');
  if (!(amount > 0)) throw new AppError(400, 'amount must be greater than zero');

  let checkoutRequestId, merchantRequestId;

  if (MPESA_MOCK) {
    checkoutRequestId = `ws_CO_MOCK_${crypto.randomBytes(8).toString('hex')}`;
    merchantRequestId = `MOCK-${crypto.randomBytes(6).toString('hex')}`;
  } else {
    const ts = darajaTimestamp();
    const token = await getAccessToken();
    const res = await fetch(`${BASE_URL}/mpesa/stkpush/v1/processrequest`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        BusinessShortCode: SHORTCODE,
        Password: darajaPassword(ts),
        Timestamp: ts,
        TransactionType: 'CustomerPayBillOnline',
        Amount: Math.round(amount),
        PartyA: phone,
        PartyB: SHORTCODE,
        PhoneNumber: phone,
        CallBackURL: CALLBACK_URL,
        AccountReference: account.card_code,
        TransactionDesc: 'HASS NATION points top-up',
      }),
    });
    const data = await res.json();
    if (!res.ok || !data.CheckoutRequestID) {
      throw new AppError(502, data.errorMessage || 'Daraja STK push request failed');
    }
    checkoutRequestId = data.CheckoutRequestID;
    merchantRequestId = data.MerchantRequestID;
  }

  const insert = db.prepare(`
    INSERT INTO mpesa_transactions (account_id, phone, amount, checkout_request_id, merchant_request_id, status, mock)
    VALUES (?, ?, ?, ?, ?, 'pending', ?)
  `).run(accountId, phone, amount, checkoutRequestId, merchantRequestId, MPESA_MOCK ? 1 : 0);

  const result = { id: insert.lastInsertRowid, checkoutRequestId, merchantRequestId, mock: MPESA_MOCK };
  if (MPESA_MOCK) {
    result.note = 'MPESA_MOCK=true — no real STK push was sent. Use scripts/simulateMpesaCallback.js, or the Simulate buttons in the console, to resolve it.';
  }
  return result;
}

/**
 * Handles the callback Safaricom POSTs back with the payment result —
 * mirrors the exact Body.stkCallback shape Daraja documents. This is the
 * ONE function that should ever credit points for a top-up.
 */
function handleCallback(body) {
  const stkCallback = body && body.Body && body.Body.stkCallback;
  if (!stkCallback) throw new AppError(400, 'Malformed M-Pesa callback payload');

  const { CheckoutRequestID, ResultCode, ResultDesc, CallbackMetadata } = stkCallback;
  const txn = db.prepare('SELECT * FROM mpesa_transactions WHERE checkout_request_id = ?').get(CheckoutRequestID);
  if (!txn) throw new AppError(404, 'No matching top-up request for this callback');

  // Safaricom retries callbacks — if we've already resolved this one,
  // acknowledge without crediting points a second time.
  if (txn.status !== 'pending') return { alreadyProcessed: true, status: txn.status };

  const succeeded = ResultCode === 0;
  let mpesaReceiptNumber = null;
  let amountPaid = txn.amount;
  if (succeeded && CallbackMetadata && Array.isArray(CallbackMetadata.Item)) {
    const find = name => CallbackMetadata.Item.find(i => i.Name === name)?.Value;
    mpesaReceiptNumber = find('MpesaReceiptNumber') ?? null;
    amountPaid = find('Amount') ?? txn.amount;
  }

  const pointsCredited = succeeded ? amountPaid * POINTS_PER_KSH : 0;

  const runBoth = db.transaction(() => {
    db.prepare(`
      UPDATE mpesa_transactions
      SET status = ?, result_code = ?, result_desc = ?, mpesa_receipt_number = ?, points_credited = ?, updated_at = datetime('now')
      WHERE id = ?
    `).run(succeeded ? 'completed' : 'failed', ResultCode, ResultDesc || null, mpesaReceiptNumber, pointsCredited, txn.id);

    if (succeeded) {
      db.prepare(`
        INSERT INTO points_ledger (account_id, delta, reason, reference_id, expires_at)
        VALUES (?, ?, 'topup', ?, datetime('now', '+12 months'))
      `).run(txn.account_id, pointsCredited, txn.id);
    }
  });
  runBoth();

  return { status: succeeded ? 'completed' : 'failed', pointsCredited };
}

/**
 * Mock-only helper: builds a realistic Daraja callback payload for a
 * pending request and feeds it through the EXACT SAME handleCallback()
 * a real webhook would hit — so "completing payment" locally exercises
 * the real code path, not a shortcut around it. Used by both the
 * console's Simulate buttons and scripts/simulateMpesaCallback.js.
 */
function simulateCallback({ checkoutRequestId, succeed = true }) {
  const txn = db.prepare('SELECT * FROM mpesa_transactions WHERE checkout_request_id = ?').get(checkoutRequestId);
  if (!txn) throw new AppError(404, 'No top-up request found for that checkout id');

  const payload = succeed
    ? {
        Body: {
          stkCallback: {
            MerchantRequestID: txn.merchant_request_id,
            CheckoutRequestID: txn.checkout_request_id,
            ResultCode: 0,
            ResultDesc: 'The service request is processed successfully.',
            CallbackMetadata: {
              Item: [
                { Name: 'Amount', Value: txn.amount },
                { Name: 'MpesaReceiptNumber', Value: `MOCK${crypto.randomBytes(4).toString('hex').toUpperCase()}` },
                { Name: 'TransactionDate', Value: Number(darajaTimestamp()) },
                { Name: 'PhoneNumber', Value: Number(txn.phone) },
              ],
            },
          },
        },
      }
    : {
        Body: {
          stkCallback: {
            MerchantRequestID: txn.merchant_request_id,
            CheckoutRequestID: txn.checkout_request_id,
            ResultCode: 1032,
            ResultDesc: 'Request cancelled by user',
          },
        },
      };

  return handleCallback(payload);
}

function getStatus(checkoutRequestId) {
  const txn = db.prepare('SELECT * FROM mpesa_transactions WHERE checkout_request_id = ?').get(checkoutRequestId);
  if (!txn) throw new AppError(404, 'No top-up request found for that checkout id');
  return txn;
}

module.exports = { initiateStkPush, handleCallback, simulateCallback, getStatus, MPESA_MOCK, MPESA_ENV };
