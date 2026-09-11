// scripts/test-scenarios.js
// Proves every rule we agreed on actually works — including the tricky
// ones. Doesn't hit the HTTP server; calls the engines directly so this
// can also run in CI later without needing a running server.
//
// Runs against its OWN throwaway database file, never your real seeded
// data — deleted and recreated fresh every time this script runs, so you
// can run `npm test` as many times as you like with no cleanup needed.

const path = require('path');
const fs = require('fs');
const TEST_DB_PATH = path.join(__dirname, '..', 'test.db');
for (const suffix of ['', '-wal', '-shm']) {
  const f = TEST_DB_PATH + suffix;
  if (fs.existsSync(f)) fs.unlinkSync(f);
}
process.env.DB_PATH = TEST_DB_PATH;

const db = require('../db');
const { recordFuelPurchase, getBalance, trailingTwelveMonthLitres, fleetTierForLitres } = require('../services/rewardEngine');
const { redeem } = require('../services/redemptionEngine');

let passed = 0, failed = 0;
function check(label, condition) {
  if (condition) { console.log(`  PASS  ${label}`); passed++; }
  else { console.log(`  FAIL  ${label}`); failed++; }
}

function freshAccount(type, cardCode) {
  db.prepare('DELETE FROM accounts WHERE card_code = ?').run(cardCode);
  const result = db.prepare(`INSERT INTO accounts (card_code, type, name) VALUES (?, ?, ?)`).run(cardCode, type, 'Test ' + cardCode);
  return result.lastInsertRowid;
}

console.log('\n=== SCENARIO 1: Individual — flat 2 points/litre, both fuels ===');
{
  const id = freshAccount('individual', 'TEST-IND-1');
  const r1 = recordFuelPurchase({ accountId: id, litres: 20, fuelType: 'petrol', station: 'Test', amountKsh: 4360 });
  check('20L petrol earns 40 points (20 x 2)', r1.pointsEarned === 40);
  const r2 = recordFuelPurchase({ accountId: id, litres: 10, fuelType: 'diesel', station: 'Test', amountKsh: 2120 });
  check('10L diesel also earns flat rate (10 x 2 = 20)', r2.pointsEarned === 20);
  check('Balance after both fill-ups is 60', getBalance(id) === 60);
}

console.log('\n=== SCENARIO 2: Individual — 500-point minimum redemption ===');
{
  const id = freshAccount('individual', 'TEST-IND-2');
  recordFuelPurchase({ accountId: id, litres: 240, fuelType: 'petrol', station: 'Test', amountKsh: 52080 }); // 480 points
  const tooEarly = redeem({ accountId: id, invoiceAmount: 5000, pointsRequested: 480 });
  check('480 points rejected — below 500 minimum', tooEarly.status === 'rejected' && tooEarly.rejectionReason.includes('minimum'));
  recordFuelPurchase({ accountId: id, litres: 10, fuelType: 'petrol', station: 'Test', amountKsh: 2170 }); // +20 points = 500 total
  const nowOk = redeem({ accountId: id, invoiceAmount: 5000, pointsRequested: 500 });
  check('500 points now approved (hit the minimum)', nowOk.status === 'approved');
  check('Discount applied is KSh 500 (1 point = KSh 1)', nowOk.discountKsh === 500);
}

console.log('\n=== SCENARIO 3: 30% invoice cap ===');
{
  const id = freshAccount('individual', 'TEST-IND-3');
  recordFuelPurchase({ accountId: id, litres: 1000, fuelType: 'petrol', station: 'Test', amountKsh: 217000 }); // 2000 points
  const overCap = redeem({ accountId: id, invoiceAmount: 2000, pointsRequested: 900 }); // cap = 600
  check('900 points on a KSh 2000 invoice rejected (cap is 600)', overCap.status === 'rejected' && overCap.rejectionReason.includes('30%'));
  const withinCap = redeem({ accountId: id, invoiceAmount: 2000, pointsRequested: 600 });
  check('600 points on a KSh 2000 invoice approved (exactly at the cap)', withinCap.status === 'approved');
  // Note: the 500-point minimum and the 30% cap only overlap on invoices of
  // roughly KSh 1,667+ (30% of that is exactly 500) — below that, no
  // redemption can ever be approved, by design of the two rules together.
}

console.log('\n=== SCENARIO 4: Fleet — tier climbs with cumulative litres ===');
{
  const id = freshAccount('fleet', 'TEST-FLEET-1');
  const r1 = recordFuelPurchase({ accountId: id, litres: 25000, fuelType: 'diesel', station: 'Test', amountKsh: 25000 * 212 });
  check('Starting from 0L, this 25,000L fill-up earns tier-1 rate (4 pts/L)', r1.ratePerLitre === 4);

  // This purchase pushes cumulative litres from 25,000 to 35,000 — crossing
  // the 30,000L boundary DURING the transaction. It still earns the OLD
  // rate in full, because the rate is decided by standing BEFORE the
  // purchase, not split mid-transaction. Worth knowing, not a bug.
  const r2 = recordFuelPurchase({ accountId: id, litres: 10000, fuelType: 'diesel', station: 'Test', amountKsh: 10000 * 212 });
  check('The fill-up that CROSSES 30,000L still earns the old rate (4 pts/L) in full', r2.ratePerLitre === 4);

  const r3 = recordFuelPurchase({ accountId: id, litres: 40000, fuelType: 'diesel', station: 'Test', amountKsh: 40000 * 212 });
  check('NEXT purchase, now starting above 30,000L, earns the new rate (5 pts/L)', r3.ratePerLitre === 5);

  const r4 = recordFuelPurchase({ accountId: id, litres: 30000, fuelType: 'diesel', station: 'Test', amountKsh: 30000 * 212 });
  check('Starting above 70,000L cumulative, rate is tier-3 (6 pts/L)', r4.ratePerLitre === 6);

  const r5 = recordFuelPurchase({ accountId: id, litres: 1000, fuelType: 'diesel', station: 'Test', amountKsh: 1000 * 212 });
  check('Starting above 100,000L cumulative, rate is the top tier (7 pts/L)', r5.ratePerLitre === 7);
}

console.log('\n=== SCENARIO 5: Redeeming does NOT lower a fleet\'s tier (the whole point of decoupling) ===');
{
  const id = freshAccount('fleet', 'TEST-FLEET-2');
  recordFuelPurchase({ accountId: id, litres: 105000, fuelType: 'diesel', station: 'Test', amountKsh: 105000 * 212 });
  const litresBefore = trailingTwelveMonthLitres(id);
  const tierBefore = fleetTierForLitres(litresBefore);
  check('Fleet is sitting at the top tier before redemption', tierBefore.rate === 7);

  const bigRedemption = redeem({ accountId: id, invoiceAmount: 5000000, pointsRequested: 300000 });
  check('Large redemption (300,000 points) approved', bigRedemption.status === 'approved');

  const litresAfter = trailingTwelveMonthLitres(id);
  const tierAfter = fleetTierForLitres(litresAfter);
  check('Litre count is UNCHANGED after redemption (still 105,000)', litresAfter === litresBefore);
  check('Tier is STILL the top tier after redeeming — this is the decoupling we agreed on', tierAfter.rate === 7);

  const nextFillUp = recordFuelPurchase({ accountId: id, litres: 100, fuelType: 'diesel', station: 'Test', amountKsh: 100 * 212 });
  check('Next litre purchased after redemption still earns the top rate', nextFillUp.ratePerLitre === 7);
}

console.log('\n=== SCENARIO 6: Rolling 12-month window — old litres roll off ===');
{
  const id = freshAccount('fleet', 'TEST-FLEET-3');
  // Backdate a large purchase to 13 months ago — it should NOT count toward the current tier.
  const insertOld = db.prepare(`
    INSERT INTO fuel_transactions (account_id, litres, fuel_type, station, amount_ksh, rate_per_litre, points_earned, tier_at_time, created_at)
    VALUES (?, ?, 'diesel', 'Test', ?, 4, ?, '0+', datetime('now', '-13 months'))
  `);
  insertOld.run(id, 90000, 90000 * 212, 90000 * 4);

  const litresNow = trailingTwelveMonthLitres(id);
  check('A 90,000L purchase from 13 months ago does NOT count toward the current window', litresNow === 0);

  const freshPurchase = recordFuelPurchase({ accountId: id, litres: 5000, fuelType: 'diesel', station: 'Test', amountKsh: 5000 * 212 });
  check('Fleet is correctly back at the bottom tier — old volume rolled off', freshPurchase.ratePerLitre === 4);
}

console.log('\n=== SCENARIO 7: Points expiry (12 months) ===');
{
  const id = freshAccount('individual', 'TEST-IND-4');
  // Insert an already-expired ledger row directly (simulating points earned over a year ago).
  db.prepare(`
    INSERT INTO points_ledger (account_id, delta, reason, expires_at, created_at)
    VALUES (?, 1000, 'fuel_purchase', datetime('now', '-1 day'), datetime('now', '-13 months'))
  `).run(id);
  check('Expired points do NOT count toward balance', getBalance(id) === 0);

  recordFuelPurchase({ accountId: id, litres: 300, fuelType: 'petrol', station: 'Test', amountKsh: 300 * 217 }); // 600 fresh points
  check('Fresh points earned after the expired batch DO count', getBalance(id) === 600);
}

console.log(`\n=== RESULT: ${passed} passed, ${failed} failed ===\n`);
process.exit(failed > 0 ? 1 : 0);
