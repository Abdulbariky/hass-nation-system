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
const { recordFuelPurchase, previewEarn, getBalance, trailingTwelveMonthLitres, fleetTierForLitres } = require('../services/rewardEngine');
const { redeem, getRedeemable } = require('../services/redemptionEngine');
const { sendOtp, verifyOtp, isPhoneVerified } = require('../services/otpService');
const { createAccount, rankForVehicleType } = require('../services/accountService');
const { PUMP_PRICES, getPumpPrices } = require('../services/pumpPriceService');
const { login, logout, getStaffForToken, hashPassword, verifyPassword } = require('../services/auth');
const { requestLogin, confirmLogin, getAccountIdForToken, logout: fleetLogout, findFleetAccountByPhone } = require('../services/fleetAuthService');
const { listVehicles, addVehicle, deactivateVehicle, requireOwnedVehicle, getVehicle } = require('../services/vehicleService');
const { initiateStkPush, handleCallback, simulateCallback, getStatus, MPESA_MOCK } = require('../services/mpesaService');
const { handleUssdRequest } = require('../services/ussdService');

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

function freshStaff({ name, phone, email, password, role }) {
  db.prepare('DELETE FROM staff_users WHERE phone = ? OR email = ?').run(phone || null, email || null);
  const result = db.prepare(`
    INSERT INTO staff_users (name, phone, email, password_hash, role, station)
    VALUES (?, ?, ?, ?, ?, 'Test Station')
  `).run(name, phone || null, email || null, hashPassword(password), role);
  return result.lastInsertRowid;
}

// Reads back the code otpService just generated — the same way a test
// stands in for the SMS the customer would actually receive.
function latestOtpCode(phone) {
  return db.prepare('SELECT code FROM otp_verifications WHERE phone = ? ORDER BY id DESC LIMIT 1').get(phone).code;
}

// Sends and immediately verifies an OTP for a phone, so scenarios that just
// need "a verified phone" don't have to repeat the send/read-back/verify dance.
async function verifiedPhone(phone) {
  await sendOtp(phone);
  verifyOtp(phone, latestOtpCode(phone));
}

// Creates a real fleet account through the actual createAccount() path
// (OTP-verified phone, vehicle_type -> rank, the works) so fleet-manager
// login tests exercise the exact same account shape the console creates.
async function freshFleetAccount({ name, phone, contactPersonPhone }) {
  await verifiedPhone(phone);
  return createAccount({
    type: 'fleet', name, phone, vehicleType: 'long_haul_fleet',
    organisationName: name, location: 'Nairobi',
    contactPersonName: 'Contact for ' + name, contactPersonPhone: contactPersonPhone || null,
  });
}

(async () => {

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

console.log('\n=== SCENARIO 8: OTP — send, then verify with the correct code succeeds ===');
{
  const phone = '0722000001';
  await sendOtp(phone);
  const code = latestOtpCode(phone);
  check('A 6-digit code was generated', /^\d{6}$/.test(code));
  const result = verifyOtp(phone, code);
  check('Correct code verifies successfully', result.verified === true);
  check('Phone is now considered verified for account creation', isPhoneVerified(phone) === true);
}

console.log('\n=== SCENARIO 9: OTP — wrong code rejected, and a used code cannot be reused ===');
{
  const phone = '0722000002';
  await sendOtp(phone);
  const code = latestOtpCode(phone);
  const wrongCode = code === '000000' ? '111111' : '000000';

  let wrongRejected = false;
  try { verifyOtp(phone, wrongCode); } catch (e) { wrongRejected = true; }
  check('Wrong code is rejected', wrongRejected);

  const ok = verifyOtp(phone, code);
  check('Correct code still verifies after a wrong guess', ok.verified === true);

  let reused = false;
  try { verifyOtp(phone, code); } catch (e) { reused = e.message.toLowerCase().includes('already been used'); }
  check('The same code cannot be verified a second time', reused);
}

console.log('\n=== SCENARIO 10: OTP — expired code is rejected ===');
{
  const phone = '0722000003';
  db.prepare(`
    INSERT INTO otp_verifications (phone, code, expires_at)
    VALUES (?, '123456', datetime('now', '-1 minute'))
  `).run(phone);

  let expiredRejected = false;
  try { verifyOtp(phone, '123456'); } catch (e) { expiredRejected = e.message.toLowerCase().includes('expired'); }
  check('Expired code is rejected with an "expired" message', expiredRejected);
  check('Phone is NOT considered verified — the code never actually matched successfully', isPhoneVerified(phone) === false);
}

console.log('\n=== SCENARIO 11: OTP — max 5 verify attempts per phone per hour ===');
{
  const phone = '0722000004';
  await sendOtp(phone);
  for (let i = 0; i < 5; i++) {
    try { verifyOtp(phone, '000000'); } catch (e) { /* expected — wrong code, but it still counts as an attempt */ }
  }
  let rateLimited = false;
  try { verifyOtp(phone, '000000'); } catch (e) { rateLimited = e.message.toLowerCase().includes('too many'); }
  check('6th verify attempt within the hour is rate-limited, regardless of code', rateLimited);
}

console.log('\n=== SCENARIO 12: Account creation is blocked until the phone is OTP-verified ===');
{
  const phone = '0722000005';
  let blocked = false;
  try {
    createAccount({ type: 'individual', name: 'Unverified Guy', phone, vehicleType: 'personal_car' });
  } catch (e) { blocked = e.status === 403; }
  check('Account creation is rejected before the phone is verified', blocked);

  await verifiedPhone(phone);
  const accountId = createAccount({ type: 'individual', name: 'Verified Guy', phone, vehicleType: 'personal_car' });
  const account = db.prepare('SELECT * FROM accounts WHERE id = ?').get(accountId);
  check('Account is created once the phone is verified', !!account);
  check('Card code was auto-generated with the WAR prefix (personal_car -> warrior)', /^WAR-\d{5}$/.test(account.card_code));
  check('Rank was set from vehicle type, not typed manually', account.rank === 'warrior');
}

console.log('\n=== SCENARIO 13: Vehicle type decides rank and card-code prefix; numbering is sequential ===');
{
  const cases = [
    ['boda_boda', 'captain'], ['matatu', 'captain'], ['school_bus', 'captain'],
    ['personal_car', 'warrior'], ['corporate_car', 'warrior'], ['uber_taxi', 'warrior'],
    ['truck', 'commander'], ['trailer', 'commander'], ['long_haul_fleet', 'commander'],
  ];
  const allMapped = cases.every(([vehicleType, rank]) => rankForVehicleType(vehicleType) === rank);
  check('Every vehicle type maps to its expected rank', allMapped);

  const phoneA = '0722000010', phoneB = '0722000011';
  await verifiedPhone(phoneA);
  await verifiedPhone(phoneB);
  const idA = createAccount({ type: 'individual', name: 'Truck A', phone: phoneA, vehicleType: 'truck' });
  const idB = createAccount({ type: 'fleet', name: 'Trailer Fleet B', phone: phoneB, vehicleType: 'trailer' });
  const acctA = db.prepare('SELECT * FROM accounts WHERE id = ?').get(idA);
  const acctB = db.prepare('SELECT * FROM accounts WHERE id = ?').get(idB);
  const numA = parseInt(acctA.card_code.split('-')[1], 10);
  const numB = parseInt(acctB.card_code.split('-')[1], 10);
  check('Two CMD-prefixed accounts get strictly increasing sequential numbers', numB === numA + 1);
  check('Card code is zero-padded to 5 digits', /^CMD-\d{5}$/.test(acctA.card_code));
}

console.log('\n=== SCENARIO 14: Rank/vehicle type never changes the earn rate — only account type does ===');
{
  const phoneCap = '0722000020', phoneCmd = '0722000021';
  await verifiedPhone(phoneCap);
  await verifiedPhone(phoneCmd);
  const idCaptain = createAccount({ type: 'individual', name: 'Boda Rider', phone: phoneCap, vehicleType: 'boda_boda' });
  const idCommander = createAccount({ type: 'individual', name: 'Truck Owner-Operator', phone: phoneCmd, vehicleType: 'truck' });

  const r1 = recordFuelPurchase({ accountId: idCaptain, litres: 10, fuelType: 'petrol', station: 'Test', amountKsh: 2170 });
  const r2 = recordFuelPurchase({ accountId: idCommander, litres: 10, fuelType: 'petrol', station: 'Test', amountKsh: 2170 });
  check('Captain-ranked individual earns the flat individual rate', r1.ratePerLitre === 2);
  check('Commander-ranked individual earns the SAME flat rate — rank never touched the maths', r2.ratePerLitre === r1.ratePerLitre);
}

console.log('\n=== SCENARIO 15: Fleet-only fields are stored for fleets, left null for individuals ===');
{
  const phoneFleet = '0722000030', phoneInd = '0722000031';
  await verifiedPhone(phoneFleet);
  await verifiedPhone(phoneInd);

  const fleetId = createAccount({
    type: 'fleet', name: 'Test Sacco', phone: phoneFleet, vehicleType: 'long_haul_fleet',
    organisationName: 'Test Sacco Ltd', location: 'Nairobi', contactPersonName: 'Jane W.', contactPersonPhone: '0700111222',
  });
  const fleetAcct = db.prepare('SELECT * FROM accounts WHERE id = ?').get(fleetId);
  check('Organisation name stored for a fleet account', fleetAcct.organisation_name === 'Test Sacco Ltd');
  check('Location stored for a fleet account', fleetAcct.location === 'Nairobi');
  check('Contact person stored for a fleet account', fleetAcct.contact_person_name === 'Jane W.' && fleetAcct.contact_person_phone === '0700111222');

  const indId = createAccount({ type: 'individual', name: 'Solo Driver', phone: phoneInd, vehicleType: 'personal_car' });
  const indAcct = db.prepare('SELECT * FROM accounts WHERE id = ?').get(indId);
  check('Fleet-only fields are left null for an individual account', indAcct.organisation_name === null && indAcct.location === null);
}

console.log('\n=== SCENARIO 16: Account lookup by phone number (same query the /by-phone route runs) ===');
{
  const phone = '0722000040';
  await verifiedPhone(phone);
  const id = createAccount({ type: 'individual', name: 'Phone Lookup Test', phone, vehicleType: 'matatu' });
  const found = db.prepare('SELECT * FROM accounts WHERE phone = ?').get(phone);
  check("Account can be found by phone number, matching the /by-phone route's query", found && found.id === id);
}

console.log('\n=== SCENARIO 17: Fuel preview matches the real earn calculation for an individual, and writes nothing ===');
{
  const id = freshAccount('individual', 'TEST-PREVIEW-IND');
  const balanceBefore = getBalance(id);
  const preview = previewEarn({ accountId: id, litres: 20 });
  check('Preview rate matches the flat individual rate', preview.ratePerLitre === 2);
  check('Preview points match litres x rate (20 x 2 = 40)', preview.pointsEarned === 40);
  check('Preview did NOT touch the balance', getBalance(id) === balanceBefore);
  check('Preview did NOT write a fuel_transactions row', db.prepare('SELECT COUNT(*) AS n FROM fuel_transactions WHERE account_id = ?').get(id).n === 0);

  const real = recordFuelPurchase({ accountId: id, litres: 20, fuelType: 'petrol', station: 'Test', amountKsh: 4360 });
  check('The real purchase earns exactly what the preview promised', real.pointsEarned === preview.pointsEarned && real.ratePerLitre === preview.ratePerLitre);
}

console.log('\n=== SCENARIO 18: Fuel preview reflects a fleet\'s CURRENT tier, and never mutates trailing litres ===');
{
  const id = freshAccount('fleet', 'TEST-PREVIEW-FLEET');
  recordFuelPurchase({ accountId: id, litres: 35000, fuelType: 'diesel', station: 'Test', amountKsh: 35000 * 212 }); // now at tier-2 (5 pts/L)

  const litresBefore = trailingTwelveMonthLitres(id);
  const preview = previewEarn({ accountId: id, litres: 50000 }); // big hypothetical fill-up
  check('Preview uses the CURRENT tier (5 pts/L), not a tier as if this fill-up already happened', preview.ratePerLitre === 5);
  check('Preview tier label reflects the standing-before-purchase litres', preview.tierLabel === '30,000+');
  check('Preview points = hypothetical litres x current rate (50,000 x 5)', preview.pointsEarned === 250000);
  check('Trailing litres are UNCHANGED after a preview — it never wrote a transaction', trailingTwelveMonthLitres(id) === litresBefore);

  const real = recordFuelPurchase({ accountId: id, litres: 100, fuelType: 'diesel', station: 'Test', amountKsh: 100 * 212 });
  check('A real purchase right after still earns the same current tier the preview reported', real.ratePerLitre === 5);
}

console.log('\n=== SCENARIO 19: Pump prices are configurable constants, exposed read-only ===');
{
  check('Default diesel pump price is 212/L', PUMP_PRICES.diesel === 212);
  check('Default petrol pump price is 217.86/L', PUMP_PRICES.petrol === 217.86);
  const copy = getPumpPrices();
  copy.diesel = 999;
  check('getPumpPrices() returns a copy — mutating it does not touch the real constants', PUMP_PRICES.diesel === 212);
}

console.log('\n=== SCENARIO 20: Redeemable preview is capped by BALANCE when that\'s the binding constraint, and writes nothing ===');
{
  const id = freshAccount('individual', 'TEST-REDEEMABLE-1');
  recordFuelPurchase({ accountId: id, litres: 300, fuelType: 'petrol', station: 'Test', amountKsh: 300 * 217 }); // 600 points
  const balanceBefore = getBalance(id);

  const preview = getRedeemable({ accountId: id, invoiceAmount: 100000 }); // cap = 30,000, way above balance
  check('maxRedeemable equals the balance, not the (much larger) cap', preview.maxRedeemable === 600);
  check('No rejection reason when a redemption is actually possible', preview.reason === null);
  check('Preview did NOT touch the balance', getBalance(id) === balanceBefore);
  check('Preview did NOT write a redemptions row', db.prepare('SELECT COUNT(*) AS n FROM redemptions WHERE account_id = ?').get(id).n === 0);

  const real = redeem({ accountId: id, invoiceAmount: 100000, pointsRequested: preview.maxRedeemable });
  check('Redeeming exactly what the preview promised is approved', real.status === 'approved');
}

console.log('\n=== SCENARIO 21: Redeemable preview is capped by the 30% INVOICE CAP when that\'s the binding constraint ===');
{
  const id = freshAccount('individual', 'TEST-REDEEMABLE-2');
  recordFuelPurchase({ accountId: id, litres: 1000, fuelType: 'petrol', station: 'Test', amountKsh: 1000 * 217 }); // 2000 points

  const preview = getRedeemable({ accountId: id, invoiceAmount: 2000 }); // cap = 600, well below balance
  check('maxRedeemable equals the 30% cap, not the (much larger) balance', preview.maxRedeemable === 600);
  check('Cap field reported matches the 30% cap for this invoice', preview.cap === 600);

  const tooMuch = redeem({ accountId: id, invoiceAmount: 2000, pointsRequested: preview.maxRedeemable + 1 });
  check('One point above what the preview promised is still rejected by the real rule', tooMuch.status === 'rejected');
  const justRight = redeem({ accountId: id, invoiceAmount: 2000, pointsRequested: preview.maxRedeemable });
  check('Exactly what the preview promised is approved', justRight.status === 'approved');
}

console.log('\n=== SCENARIO 22: Redeemable preview returns zero + a plain-English reason when BALANCE is below the minimum ===');
{
  const id = freshAccount('individual', 'TEST-REDEEMABLE-3');
  recordFuelPurchase({ accountId: id, litres: 20, fuelType: 'petrol', station: 'Test', amountKsh: 20 * 217 }); // 40 points — well under 500

  const preview = getRedeemable({ accountId: id, invoiceAmount: 100000 }); // cap is huge, balance is the problem
  check('maxRedeemable is zero', preview.maxRedeemable === 0);
  check('Reason explains it\'s the balance that\'s short of the minimum', preview.reason && preview.reason.toLowerCase().includes('balance'));
}

console.log('\n=== SCENARIO 23: Redeemable preview returns zero + a plain-English reason when the 30% CAP is below the minimum ===');
{
  const id = freshAccount('individual', 'TEST-REDEEMABLE-4');
  recordFuelPurchase({ accountId: id, litres: 1000, fuelType: 'petrol', station: 'Test', amountKsh: 1000 * 217 }); // 2000 points, plenty

  const preview = getRedeemable({ accountId: id, invoiceAmount: 1000 }); // cap = 300, below the 500 minimum
  check('maxRedeemable is zero even though the balance is plenty', preview.maxRedeemable === 0);
  check('Reason explains it\'s the 30% cap that\'s short of the minimum, not the balance', preview.reason && preview.reason.includes('30%'));
}

console.log('\n=== SCENARIO 24: Staff passwords are stored as bcrypt hashes, never plaintext ===');
{
  const staffId = freshStaff({ name: 'Attendant One', phone: '0733000001', password: 'correct-horse', role: 'attendant' });
  const row = db.prepare('SELECT * FROM staff_users WHERE id = ?').get(staffId);
  check('The stored password_hash is not the plaintext password', row.password_hash !== 'correct-horse');
  check('The stored hash looks like a bcrypt hash ($2...)', /^\$2[aby]?\$/.test(row.password_hash));
  check('verifyPassword() accepts the correct password against the stored hash', verifyPassword('correct-horse', row.password_hash));
  check('verifyPassword() rejects a wrong password against the stored hash', !verifyPassword('wrong-password', row.password_hash));
}

console.log('\n=== SCENARIO 25: Login succeeds by phone OR email with the right password, fails otherwise ===');
{
  freshStaff({ name: 'Attendant Two', phone: '0733000002', email: 'attendant2@example.test', password: 'p@ssw0rd!', role: 'attendant' });

  const byPhone = login('0733000002', 'p@ssw0rd!');
  check('Login by phone succeeds with the right password', byPhone.staff.name === 'Attendant Two');
  check('Login response never includes the password hash', byPhone.staff.password_hash === undefined);

  const byEmail = login('attendant2@example.test', 'p@ssw0rd!');
  check('Login by email also succeeds', byEmail.staff.name === 'Attendant Two');

  let wrongPasswordRejected = false;
  try { login('0733000002', 'not-the-password'); } catch (e) { wrongPasswordRejected = e.status === 401; }
  check('Login with the wrong password is rejected (401)', wrongPasswordRejected);

  let unknownRejected = false;
  try { login('0733009999', 'anything'); } catch (e) { unknownRejected = e.status === 401; }
  check('Login with an unknown identifier is rejected (401)', unknownRejected);
}

console.log('\n=== SCENARIO 26: Session tokens authenticate until logout, then stop working ===');
{
  freshStaff({ name: 'Attendant Three', phone: '0733000003', password: 'letmein123', role: 'attendant' });
  const { token } = login('0733000003', 'letmein123');

  const staffForToken = getStaffForToken(token);
  check('A fresh token resolves back to the logged-in staff member', staffForToken && staffForToken.name === 'Attendant Three');

  check('A made-up token resolves to nothing', getStaffForToken('not-a-real-token') === null);

  logout(token);
  check('After logout, the same token no longer resolves to anyone', getStaffForToken(token) === null);
}

console.log('\n=== SCENARIO 27: An expired session no longer authenticates ===');
{
  const staffId = freshStaff({ name: 'Attendant Four', phone: '0733000004', password: 'irrelevant', role: 'attendant' });
  db.prepare(`
    INSERT INTO staff_sessions (token, staff_id, expires_at)
    VALUES ('expired-test-token', ?, datetime('now', '-1 minute'))
  `).run(staffId);
  check('A session past its expiry no longer authenticates', getStaffForToken('expired-test-token') === null);
}

console.log('\n=== SCENARIO 28: Fuel purchases and redemptions record WHICH staff member acted ===');
{
  const staffId = freshStaff({ name: 'Attendant Five', phone: '0733000005', password: 'irrelevant', role: 'attendant' });
  const otherStaffId = freshStaff({ name: 'Admin One', phone: '0733000006', password: 'irrelevant', role: 'admin' });

  const accountId = freshAccount('individual', 'TEST-STAFF-TRACKING');
  const fuelResult = recordFuelPurchase({ accountId, litres: 50, fuelType: 'diesel', station: 'Test', amountKsh: 50 * 212, staffId });
  const fuelRow = db.prepare('SELECT staff_id FROM fuel_transactions WHERE id = ?').get(fuelResult.transactionId);
  check('The fuel_transactions row records the attendant who ran it', fuelRow.staff_id === staffId);

  const redeemResult = redeem({ accountId, invoiceAmount: 100000, pointsRequested: 100, staffId: otherStaffId });
  const redemptionRow = db.prepare('SELECT staff_id FROM redemptions WHERE id = ?').get(redeemResult.redemptionId);
  check('The redemptions row records the (possibly different) staff member who approved it', redemptionRow.staff_id === otherStaffId);
  check('Two different staff members can be recorded on two different actions for the same account', fuelRow.staff_id !== redemptionRow.staff_id);
}

console.log('\n=== SCENARIO 29: Fleet manager login — phone + OTP, reusing the existing OTP system ===');
{
  const phone = '0744000001';
  const contactPhone = '0744000002';
  const accountId = await freshFleetAccount({ name: 'Fleet Login Test Co', phone, contactPersonPhone: contactPhone });

  await requestLogin(phone); // sends an OTP the same way account-creation verification does
  const code = latestOtpCode(phone);
  const { token, account } = confirmLogin(phone, code);
  check('confirmLogin() returns a token', typeof token === 'string' && token.length > 10);
  check('confirmLogin() resolves to the right fleet account', account.id === accountId);
  check('getAccountIdForToken() resolves the token back to that same account', getAccountIdForToken(token) === accountId);

  // The contact person's phone (a different number from the account's main
  // phone) must also be able to log in to the SAME account.
  await requestLogin(contactPhone);
  const contactCode = latestOtpCode(contactPhone);
  const contactLogin = confirmLogin(contactPhone, contactCode);
  check('The contact person\'s phone logs into the SAME fleet account as the main phone', contactLogin.account.id === accountId);
}

console.log('\n=== SCENARIO 30: Fleet login is fleet-only — an individual account\'s phone cannot use it ===');
{
  const phone = '0744000010';
  await verifiedPhone(phone);
  const indId = createAccount({ type: 'individual', name: 'Not A Fleet', phone, vehicleType: 'personal_car' });
  check('Sanity: the account really was created as individual', db.prepare('SELECT type FROM accounts WHERE id = ?').get(indId).type === 'individual');

  let rejected = false;
  try { await requestLogin(phone); } catch (e) { rejected = e.status === 404; }
  check('requestLogin() rejects a phone that only belongs to an individual account', rejected);
  check('findFleetAccountByPhone() finds nothing for it either', findFleetAccountByPhone(phone) === undefined);
}

console.log('\n=== SCENARIO 31: An expired fleet session no longer authenticates ===');
{
  const accountId = await freshFleetAccount({ name: 'Expiry Test Fleet', phone: '0744000020' });
  db.prepare(`
    INSERT INTO fleet_sessions (token, account_id, phone, expires_at)
    VALUES ('expired-fleet-token', ?, '0744000020', datetime('now', '-1 minute'))
  `).run(accountId);
  check('An expired fleet session token resolves to nothing', getAccountIdForToken('expired-fleet-token') === null);

  await requestLogin('0744000020');
  const { token } = confirmLogin('0744000020', latestOtpCode('0744000020'));
  fleetLogout(token);
  check('After fleet logout, the token no longer resolves either', getAccountIdForToken(token) === null);
}

console.log('\n=== SCENARIO 32: A fleet manager can add and deactivate their own vehicles ===');
{
  const accountId = await freshFleetAccount({ name: 'Vehicle Owner Fleet', phone: '0744000030' });
  const vehicle = addVehicle({ accountId, registrationNumber: 'KDA 111A', vehicleType: 'truck', driverName: 'James O.', driverPhone: '0700000001' });
  check('Vehicle is created active by default', vehicle.active === 1);
  check('Vehicle is listed under its owning account', listVehicles(accountId).some(v => v.id === vehicle.id));

  const deactivated = deactivateVehicle(vehicle.id, accountId);
  check('Deactivating (by the owning account) flips active to 0', deactivated.active === 0);
  check('Deactivated vehicle still appears in the list (just inactive), not deleted', listVehicles(accountId).some(v => v.id === vehicle.id && v.active === 0));
}

console.log('\n=== SCENARIO 33: Vehicles can only be added to FLEET accounts, not individuals ===');
{
  const id = freshAccount('individual', 'TEST-NO-VEHICLES');
  let rejected = false;
  try { addVehicle({ accountId: id, registrationNumber: 'KAA 000A' }); } catch (e) { rejected = e.status === 400; }
  check('Adding a vehicle to an individual account is rejected', rejected);
}

console.log('\n=== SCENARIO 34: ISOLATION — one fleet account can never read, deactivate, or otherwise touch another fleet\'s vehicles ===');
{
  const accountA = await freshFleetAccount({ name: 'Isolation Fleet A', phone: '0744000040' });
  const accountB = await freshFleetAccount({ name: 'Isolation Fleet B', phone: '0744000041' });

  const vehicleA = addVehicle({ accountId: accountA, registrationNumber: 'KDA 222A', driverName: 'Driver A' });
  const vehicleB = addVehicle({ accountId: accountB, registrationNumber: 'KDB 333B', driverName: 'Driver B' });

  // Log in as both, to prove the SESSIONS themselves stay separate too.
  await requestLogin('0744000040');
  const sessionA = confirmLogin('0744000040', latestOtpCode('0744000040'));
  await requestLogin('0744000041');
  const sessionB = confirmLogin('0744000041', latestOtpCode('0744000041'));
  check('Fleet A\'s session resolves to Fleet A\'s account, never Fleet B\'s', getAccountIdForToken(sessionA.token) === accountA && getAccountIdForToken(sessionA.token) !== accountB);
  check('Fleet B\'s session resolves to Fleet B\'s account, never Fleet A\'s', getAccountIdForToken(sessionB.token) === accountB && getAccountIdForToken(sessionB.token) !== accountA);

  // This is the exact check routes/fleet.js runs before touching a vehicle —
  // requireOwnedVehicle(vehicleId, req.fleetAccountId) — proven directly here.
  let crossReadBlocked = false;
  try { requireOwnedVehicle(vehicleB.id, accountA); } catch (e) { crossReadBlocked = e.status === 404; }
  check('Fleet A is refused (404) when it tries to read Fleet B\'s vehicle by id', crossReadBlocked);

  let crossDeactivateBlocked = false;
  try { deactivateVehicle(vehicleB.id, accountA); } catch (e) { crossDeactivateBlocked = e.status === 404; }
  check('Fleet A is refused (404) when it tries to deactivate Fleet B\'s vehicle', crossDeactivateBlocked);
  check('Fleet B\'s vehicle is UNCHANGED by Fleet A\'s attempt — still active', getVehicle(vehicleB.id).active === 1);

  check('Fleet A\'s vehicle list does NOT include Fleet B\'s vehicle', !listVehicles(accountA).some(v => v.id === vehicleB.id));
  check('Fleet B\'s vehicle list does NOT include Fleet A\'s vehicle', !listVehicles(accountB).some(v => v.id === vehicleA.id));
}

console.log('\n=== SCENARIO 35: Fuel purchases optionally record a vehicle, scoped to the right account\'s history ===');
{
  const accountA = await freshFleetAccount({ name: 'Vehicle Fuel Fleet A', phone: '0744000050' });
  const accountB = await freshFleetAccount({ name: 'Vehicle Fuel Fleet B', phone: '0744000051' });
  const vehicleA = addVehicle({ accountId: accountA, registrationNumber: 'KDC 444C' });
  const vehicleB = addVehicle({ accountId: accountB, registrationNumber: 'KDD 555D' });

  const purchase = recordFuelPurchase({ accountId: accountA, litres: 500, fuelType: 'diesel', station: 'Test', amountKsh: 500 * 212, vehicleId: vehicleA.id });
  const fuelRow = db.prepare('SELECT vehicle_id FROM fuel_transactions WHERE id = ?').get(purchase.transactionId);
  check('The fuel_transactions row records the vehicle it was for', fuelRow.vehicle_id === vehicleA.id);

  let mismatchRejected = false;
  try {
    recordFuelPurchase({ accountId: accountA, litres: 10, fuelType: 'diesel', station: 'Test', amountKsh: 2120, vehicleId: vehicleB.id });
  } catch (e) { mismatchRejected = e.status === 400; }
  check('Fuelling account A while naming account B\'s vehicle is rejected', mismatchRejected);

  const historyForA = db.prepare('SELECT * FROM fuel_transactions WHERE vehicle_id = ?').all(vehicleA.id);
  const historyForB = db.prepare('SELECT * FROM fuel_transactions WHERE vehicle_id = ?').all(vehicleB.id);
  check('Vehicle A\'s history contains its own fill-up', historyForA.length === 1);
  check('Vehicle B\'s history is untouched by A\'s fill-up (the rejected cross-account attempt wrote nothing)', historyForB.length === 0);
}

console.log('\n=== SCENARIO 36: M-Pesa top-up — mock STK push initiate creates a pending request, credits nothing yet ===');
{
  check('MPESA_MOCK is on for this test run (no real Safaricom calls)', MPESA_MOCK === true);

  const id = freshAccount('individual', 'TEST-MPESA-1');
  const balanceBefore = getBalance(id);
  const push = await initiateStkPush({ accountId: id, phone: '0755000001', amount: 1000 });
  check('Mock STK push is flagged as mocked', push.mock === true);
  check('A checkoutRequestId is returned', typeof push.checkoutRequestId === 'string' && push.checkoutRequestId.length > 5);

  const status = getStatus(push.checkoutRequestId);
  check('The top-up request starts pending', status.status === 'pending');
  check('No points are credited while pending', getBalance(id) === balanceBefore);
}

console.log('\n=== SCENARIO 37: Simulating a successful payment credits points 1:1 and marks the request completed ===');
{
  const id = freshAccount('individual', 'TEST-MPESA-2');
  const push = await initiateStkPush({ accountId: id, phone: '0755000002', amount: 2500 });

  const result = simulateCallback({ checkoutRequestId: push.checkoutRequestId, succeed: true });
  check('simulateCallback() reports completed', result.status === 'completed');
  check('Points credited match the KSh amount 1:1 (2500 KSh -> 2500 points)', result.pointsCredited === 2500);
  check('Balance reflects the credited points', getBalance(id) === 2500);

  const status = getStatus(push.checkoutRequestId);
  check('The stored request is now completed', status.status === 'completed');
  check('An M-Pesa receipt number was recorded', !!status.mpesa_receipt_number);

  const ledgerRow = db.prepare(`SELECT * FROM points_ledger WHERE account_id = ? AND reason = 'topup'`).get(id);
  check('A points_ledger row with reason \'topup\' was written', !!ledgerRow && ledgerRow.delta === 2500);
  check('Top-up points expire 12 months out, same as fuel-purchase points', ledgerRow.expires_at > db.prepare(`SELECT datetime('now', '+11 months') AS d`).get().d);
}

console.log('\n=== SCENARIO 38: Simulating a cancelled/failed payment credits nothing ===');
{
  const id = freshAccount('individual', 'TEST-MPESA-3');
  const push = await initiateStkPush({ accountId: id, phone: '0755000003', amount: 500 });

  const result = simulateCallback({ checkoutRequestId: push.checkoutRequestId, succeed: false });
  check('simulateCallback() reports failed', result.status === 'failed');
  check('No points are credited for a failed/cancelled payment', getBalance(id) === 0);
  check('The stored request is marked failed', getStatus(push.checkoutRequestId).status === 'failed');
}

console.log('\n=== SCENARIO 39: A retried callback (Safaricom resending the same result) never double-credits points ===');
{
  const id = freshAccount('individual', 'TEST-MPESA-4');
  const push = await initiateStkPush({ accountId: id, phone: '0755000004', amount: 1000 });

  simulateCallback({ checkoutRequestId: push.checkoutRequestId, succeed: true });
  check('First callback credits the points once', getBalance(id) === 1000);

  const retryResult = simulateCallback({ checkoutRequestId: push.checkoutRequestId, succeed: true });
  check('A retried callback is recognised as already processed', retryResult.alreadyProcessed === true);
  check('Balance is unchanged by the retry — no double-crediting', getBalance(id) === 1000);
}

console.log('\n=== SCENARIO 40: STK push validation — bad account, bad amount, missing phone ===');
{
  let noAccount = false;
  try { await initiateStkPush({ accountId: 999999, phone: '0755000005', amount: 100 }); } catch (e) { noAccount = e.status === 404; }
  check('STK push for a nonexistent account is rejected', noAccount);

  const id = freshAccount('individual', 'TEST-MPESA-5');
  let badAmount = false;
  try { await initiateStkPush({ accountId: id, phone: '0755000005', amount: 0 }); } catch (e) { badAmount = e.status === 400; }
  check('STK push with a zero/negative amount is rejected', badAmount);

  let noPhone = false;
  try { await initiateStkPush({ accountId: id, phone: '', amount: 100 }); } catch (e) { noPhone = e.status === 400; }
  check('STK push with no phone is rejected', noPhone);
}

console.log('\n=== SCENARIO 41: A callback for an unrecognised checkout id is rejected ===');
{
  let rejected = false;
  try {
    handleCallback({ Body: { stkCallback: { CheckoutRequestID: 'does-not-exist', ResultCode: 0 } } });
  } catch (e) { rejected = e.status === 404; }
  check('An unknown checkoutRequestId in a callback is rejected', rejected);
}

console.log('\n=== SCENARIO 42: USSD — the root menu is a CON (session continues) ===');
{
  const response = handleUssdRequest({ phoneNumber: '0711000001', text: '' });
  check('Root menu starts with CON (keeps the session open)', response.startsWith('CON '));
  check('Root menu lists both options', response.includes('Check points balance') && response.includes('Recent transactions'));
}

console.log('\n=== SCENARIO 43: USSD — checking balance for an unknown phone ends the session politely ===');
{
  const response = handleUssdRequest({ phoneNumber: '0700000000', text: '1' });
  check('Unknown phone gets an END response', response.startsWith('END '));
  check('Unknown phone gets a clear "no account" message', response.includes('No HASS NATION account found'));
}

console.log('\n=== SCENARIO 44: USSD — checking balance for a real account matches the actual balance ===');
{
  const phone = '0755100001';
  await verifiedPhone(phone);
  const id = createAccount({ type: 'individual', name: 'USSD Balance Test', phone, vehicleType: 'personal_car' });
  recordFuelPurchase({ accountId: id, litres: 100, fuelType: 'petrol', station: 'Test', amountKsh: 100 * 217 }); // 200 points

  const response = handleUssdRequest({ phoneNumber: phone, text: '1' });
  check('Balance menu ends the session (END)', response.startsWith('END '));
  check('Reported balance matches getBalance() exactly', response.includes(`${Math.round(getBalance(id))} points`));
}

console.log('\n=== SCENARIO 45: USSD — recent transactions match real history, most recent first ===');
{
  const phone = '0755100002';
  await verifiedPhone(phone);
  const id = createAccount({ type: 'individual', name: 'USSD History Test', phone, vehicleType: 'personal_car' });
  const fuelResult = recordFuelPurchase({ accountId: id, litres: 300, fuelType: 'petrol', station: 'Test', amountKsh: 300 * 217 }); // 600 points, well above minimum
  // created_at only has second resolution, so back-date the earlier
  // transaction slightly — otherwise a fast test run can tie the two
  // rows to the same second and make "most recent first" unverifiable.
  db.prepare(`UPDATE fuel_transactions SET created_at = datetime('now', '-1 minute') WHERE id = ?`).run(fuelResult.transactionId);
  redeem({ accountId: id, invoiceAmount: 100000, pointsRequested: 500 });

  const response = handleUssdRequest({ phoneNumber: phone, text: '2' });
  check('Transaction history ends the session (END)', response.startsWith('END '));
  check('History shows the earn as a positive line', response.includes('+600'));
  check('History shows the redemption as a negative line', response.includes('-500'));
  check('The most recent activity (the redemption) is listed before the earlier fill-up', response.indexOf('-500') < response.indexOf('+600'));
}

console.log('\n=== SCENARIO 46: USSD — an invalid menu choice ends the session cleanly ===');
{
  const phone = '0755100003';
  await verifiedPhone(phone);
  createAccount({ type: 'individual', name: 'USSD Invalid Choice Test', phone, vehicleType: 'personal_car' });

  const response = handleUssdRequest({ phoneNumber: phone, text: '9' });
  check('An out-of-range choice still ends cleanly rather than crashing', response === 'END Invalid choice.');
}

console.log(`\n=== RESULT: ${passed} passed, ${failed} failed ===\n`);
process.exit(failed > 0 ? 1 : 0);

})();
