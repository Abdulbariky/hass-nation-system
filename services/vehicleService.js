// services/vehicleService.js
//
// Vehicles registered under a fleet account — purely descriptive/reporting
// (which of my trucks fuelled up), never used in points maths. Individual
// accounts don't have vehicles.

const db = require('../db');
const { AppError } = require('./rewardEngine');

function listVehicles(accountId) {
  return db.prepare(`SELECT * FROM vehicles WHERE account_id = ? ORDER BY created_at DESC`).all(accountId);
}

function getVehicle(vehicleId) {
  return db.prepare('SELECT * FROM vehicles WHERE id = ?').get(vehicleId);
}

/**
 * Throws unless the vehicle exists AND belongs to accountId. This is the
 * one check every fleet-scoped route must run before touching a vehicle —
 * it's what stops one fleet manager from reading or deactivating another
 * fleet's vehicle by guessing an id.
 */
function requireOwnedVehicle(vehicleId, accountId) {
  const vehicle = getVehicle(vehicleId);
  if (!vehicle || vehicle.account_id !== Number(accountId)) {
    throw new AppError(404, 'Vehicle not found');
  }
  return vehicle;
}

function addVehicle({ accountId, registrationNumber, vehicleType, driverName, driverPhone }) {
  const account = db.prepare('SELECT * FROM accounts WHERE id = ?').get(accountId);
  if (!account) throw new AppError(404, 'Account not found');
  if (account.type !== 'fleet') throw new AppError(400, 'Only fleet accounts can have vehicles');
  if (!registrationNumber) throw new AppError(400, 'registrationNumber is required');

  const result = db.prepare(`
    INSERT INTO vehicles (account_id, registration_number, vehicle_type, driver_name, driver_phone)
    VALUES (?, ?, ?, ?, ?)
  `).run(accountId, registrationNumber, vehicleType || null, driverName || null, driverPhone || null);
  return getVehicle(result.lastInsertRowid);
}

function deactivateVehicle(vehicleId, accountId) {
  requireOwnedVehicle(vehicleId, accountId);
  db.prepare('UPDATE vehicles SET active = 0 WHERE id = ?').run(vehicleId);
  return getVehicle(vehicleId);
}

module.exports = { listVehicles, getVehicle, requireOwnedVehicle, addVehicle, deactivateVehicle };
