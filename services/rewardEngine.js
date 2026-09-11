// services/rewardEngine.js
//
// This file is the single source of truth for "how many points does this
// litre earn?" — every rule we agreed on during planning lives here and
// nowhere else. If the business ever changes a rate, this is the only
// file that needs to change.

const db = require('../db');

const POINTS_PER_KSH = 1; // our one conversion rule: 1 point = KSh 1, everywhere

// Individual track: flat rate, no tiers, same for petrol and diesel.
const INDIVIDUAL_RATE = 2; // points per litre

// Fleet track: rate depends on litres bought in the trailing 12 months.
// Ordered highest-threshold-first so we can just find the first match.
const FLEET_TIERS = [
  { min: 100000, rate: 7 },
  { min: 70000,  rate: 6 },
  { min: 30000,  rate: 5 },
  { min: 0,      rate: 4 },
];

/**
 * Sums a fleet account's litres purchased in the trailing 12 months.
 * This is deliberately a live query, not a stored field — the tier can
 * never go stale, because it's recalculated from real transaction history
 * every single time. This is also what gives us the "rolling window":
 * a litre purchased 13 months ago simply stops counting on its own,
 * nothing has to actively "expire" it.
 */
function trailingTwelveMonthLitres(accountId) {
  const row = db.prepare(`
    SELECT COALESCE(SUM(litres), 0) AS total
    FROM fuel_transactions
    WHERE account_id = ?
      AND created_at >= datetime('now', '-12 months')
  `).get(accountId);
  return row.total;
}

/**
 * Given a fleet's trailing-12-month litre total, which tier are they in?
 * Note this looks at litres BEFORE the current transaction is added, then
 * the caller adds the new litres on top — matching "what rate applies to
 * the litre being bought right now, given everything bought before it."
 */
function fleetTierForLitres(litresSoFar) {
  const tier = FLEET_TIERS.find(t => litresSoFar >= t.min);
  return tier; // FLEET_TIERS always has a 0-floor entry, so this never returns undefined
}

/**
 * Records a fuel purchase and credits points according to the rules above.
 * This is the ONE function that should ever be called to earn points —
 * never write to fuel_transactions or points_ledger directly from a route.
 */
function recordFuelPurchase({ accountId, litres, fuelType, station, amountKsh }) {
  const account = db.prepare('SELECT * FROM accounts WHERE id = ?').get(accountId);
  if (!account) throw new AppError(404, 'Account not found');
  if (litres <= 0) throw new AppError(400, 'Litres must be greater than zero');

  let ratePerLitre, tierLabel = null;

  if (account.type === 'individual') {
    ratePerLitre = INDIVIDUAL_RATE;
  } else {
    // Fleet: the rate for THIS ENTIRE fill-up is based on litres bought
    // BEFORE it started — not a per-litre split within the transaction.
    // So a fill-up that pushes a fleet from 25,000L to 35,000L still earns
    // the OLD (lower) rate in full; the new rate only applies starting with
    // their NEXT purchase. This is deliberately simple to explain and audit:
    // "your rate today is based on your last 12 months, full stop" — no
    // mid-transaction maths anyone has to double-check at the pump.
    const litresSoFar = trailingTwelveMonthLitres(accountId);
    const tier = fleetTierForLitres(litresSoFar);
    ratePerLitre = tier.rate;
    tierLabel = `${tier.min.toLocaleString()}+`;
  }

  const pointsEarned = litres * ratePerLitre * POINTS_PER_KSH;

  const insertFuel = db.prepare(`
    INSERT INTO fuel_transactions (account_id, litres, fuel_type, station, amount_ksh, rate_per_litre, points_earned, tier_at_time)
    VALUES (@accountId, @litres, @fuelType, @station, @amountKsh, @ratePerLitre, @pointsEarned, @tierLabel)
  `);

  const insertLedger = db.prepare(`
    INSERT INTO points_ledger (account_id, delta, reason, reference_id, expires_at)
    VALUES (@accountId, @delta, 'fuel_purchase', @referenceId, datetime('now', '+12 months'))
  `);

  // Wrap both writes in one transaction — a purchase should never exist
  // without its matching ledger entry, or vice versa.
  const runBoth = db.transaction(() => {
    const fuelResult = insertFuel.run({ accountId, litres, fuelType, station: station || null, amountKsh, ratePerLitre, pointsEarned, tierLabel });
    insertLedger.run({ accountId, delta: pointsEarned, referenceId: fuelResult.lastInsertRowid });
    return fuelResult.lastInsertRowid;
  });
  const transactionId = runBoth();

  return {
    transactionId,
    accountType: account.type,
    ratePerLitre,
    tierLabel,
    pointsEarned,
    newBalance: getBalance(accountId),
  };
}

/** Current spendable points balance — always summed live from the ledger, never stored. */
function getBalance(accountId) {
  const row = db.prepare(`
    SELECT COALESCE(SUM(delta), 0) AS balance
    FROM points_ledger
    WHERE account_id = ?
      AND (expires_at IS NULL OR expires_at > datetime('now'))
  `).get(accountId);
  return row.balance;
}

class AppError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

module.exports = {
  recordFuelPurchase,
  getBalance,
  trailingTwelveMonthLitres,
  fleetTierForLitres,
  INDIVIDUAL_RATE,
  FLEET_TIERS,
  AppError,
};
