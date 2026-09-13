// services/accountService.js
//
// Onboarding logic: vehicle type decides rank, rank decides the card-code
// prefix, and the account can't be created until its phone is OTP-verified.
//
// IMPORTANT: rank/vehicle_type are identity and card-design only. They must
// never feed into points maths — that's exclusively services/rewardEngine.js,
// keyed on account.type (individual vs fleet), not rank.

const db = require('../db');
const { AppError } = require('./rewardEngine');
const { isPhoneVerified } = require('./otpService');

const VEHICLE_TYPE_TO_RANK = {
  boda_boda: 'captain',
  matatu: 'captain',
  school_bus: 'captain',
  personal_car: 'warrior',
  corporate_car: 'warrior',
  uber_taxi: 'warrior',
  truck: 'commander',
  trailer: 'commander',
  long_haul_fleet: 'commander',
};

const RANK_TO_CARD_PREFIX = { captain: 'CAP', warrior: 'WAR', commander: 'CMD' };

function rankForVehicleType(vehicleType) {
  return VEHICLE_TYPE_TO_RANK[vehicleType] || null;
}

/** PREFIX-NNNNN, sequential per prefix, zero-padded to 5 digits. */
function generateCardCode(rank) {
  const prefix = RANK_TO_CARD_PREFIX[rank];
  if (!prefix) throw new AppError(400, `Unknown rank: ${rank}`);

  const rows = db.prepare(`SELECT card_code FROM accounts WHERE card_code LIKE ?`).all(`${prefix}-%`);
  let max = 0;
  for (const row of rows) {
    const match = row.card_code.match(/^[A-Z]+-(\d+)$/);
    if (match) max = Math.max(max, parseInt(match[1], 10));
  }
  return `${prefix}-${String(max + 1).padStart(5, '0')}`;
}

/**
 * Creates an account. The card code is always generated here — callers
 * never pass one in — and the phone must already have a verified OTP.
 */
function createAccount({ type, name, phone, vehicleType, organisationName, location, contactPersonName, contactPersonPhone }) {
  if (!type || !name || !phone || !vehicleType) {
    throw new AppError(400, 'type, name, phone, and vehicleType are required');
  }
  if (!['individual', 'fleet'].includes(type)) {
    throw new AppError(400, "type must be 'individual' or 'fleet'");
  }
  const rank = rankForVehicleType(vehicleType);
  if (!rank) {
    throw new AppError(400, `Unknown vehicleType: ${vehicleType}`);
  }
  if (!isPhoneVerified(phone)) {
    throw new AppError(403, 'Phone number has not been verified — send and verify an OTP first');
  }

  const cardCode = generateCardCode(rank);
  try {
    const result = db.prepare(`
      INSERT INTO accounts (card_code, type, name, phone, rank, vehicle_type, organisation_name, location, contact_person_name, contact_person_phone)
      VALUES (@cardCode, @type, @name, @phone, @rank, @vehicleType, @organisationName, @location, @contactPersonName, @contactPersonPhone)
    `).run({
      cardCode, type, name, phone, rank, vehicleType,
      organisationName: organisationName || null,
      location: location || null,
      contactPersonName: contactPersonName || null,
      contactPersonPhone: contactPersonPhone || null,
    });
    return result.lastInsertRowid;
  } catch (err) {
    if (String(err.message).includes('UNIQUE constraint failed')) {
      throw new AppError(409, 'A card with that code already exists');
    }
    throw err;
  }
}

module.exports = {
  VEHICLE_TYPE_TO_RANK,
  RANK_TO_CARD_PREFIX,
  rankForVehicleType,
  generateCardCode,
  createAccount,
};
