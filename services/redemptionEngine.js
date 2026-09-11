// services/redemptionEngine.js
//
// Every guardrail we agreed on lives here: the 500-point minimum, the 30%
// per-invoice cap, and "can't redeem more than you actually have." Points
// expiry is enforced automatically because rewardEngine.getBalance() only
// sums ledger rows that haven't expired yet — this file doesn't need to
// think about expiry at all, which is exactly the point of that design.

const db = require('../db');
const { getBalance, AppError } = require('./rewardEngine');

const MIN_REDEMPTION_POINTS = 500;
const MAX_REDEMPTION_FRACTION_OF_INVOICE = 0.30;
const POINTS_TO_KSH = 1; // same 1:1 rule as earning

function redeem({ accountId, invoiceAmount, pointsRequested }) {
  const account = db.prepare('SELECT * FROM accounts WHERE id = ?').get(accountId);
  if (!account) throw new AppError(404, 'Account not found');
  if (invoiceAmount <= 0) throw new AppError(400, 'Invoice amount must be greater than zero');
  if (pointsRequested <= 0) throw new AppError(400, 'Points requested must be greater than zero');

  const balance = getBalance(accountId);
  const maxAllowedByInvoice = invoiceAmount * MAX_REDEMPTION_FRACTION_OF_INVOICE;

  let status = 'approved';
  let rejectionReason = null;

  if (pointsRequested < MIN_REDEMPTION_POINTS) {
    status = 'rejected';
    rejectionReason = `Below the ${MIN_REDEMPTION_POINTS}-point minimum redemption`;
  } else if (pointsRequested > maxAllowedByInvoice) {
    status = 'rejected';
    rejectionReason = `Exceeds the 30% cap for this invoice (max ${Math.floor(maxAllowedByInvoice)} points)`;
  } else if (pointsRequested > balance) {
    status = 'rejected';
    rejectionReason = 'Exceeds available points balance';
  }

  const discountKsh = status === 'approved' ? pointsRequested * POINTS_TO_KSH : 0;
  const newInvoiceTotal = status === 'approved' ? invoiceAmount - discountKsh : invoiceAmount;

  const insertRedemption = db.prepare(`
    INSERT INTO redemptions (account_id, invoice_amount, points_requested, status, rejection_reason, new_invoice_total)
    VALUES (@accountId, @invoiceAmount, @pointsRequested, @status, @rejectionReason, @newInvoiceTotal)
  `);
  const insertLedger = db.prepare(`
    INSERT INTO points_ledger (account_id, delta, reason, reference_id)
    VALUES (@accountId, @delta, 'redemption', @referenceId)
  `);

  const run = db.transaction(() => {
    const redemptionResult = insertRedemption.run({ accountId, invoiceAmount, pointsRequested, status, rejectionReason, newInvoiceTotal });
    if (status === 'approved') {
      // Negative delta — this is the ONLY thing redemption touches.
      // It never writes to fuel_transactions, so a fleet's rolling-12-month
      // tier status is completely unaffected by redeeming, exactly as agreed.
      insertLedger.run({ accountId, delta: -pointsRequested, referenceId: redemptionResult.lastInsertRowid });
    }
    return redemptionResult.lastInsertRowid;
  });
  const redemptionId = run();

  return {
    redemptionId,
    status,
    rejectionReason,
    discountKsh,
    newInvoiceTotal,
    newBalance: getBalance(accountId),
  };
}

module.exports = { redeem, MIN_REDEMPTION_POINTS, MAX_REDEMPTION_FRACTION_OF_INVOICE };
