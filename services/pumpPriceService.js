// services/pumpPriceService.js
//
// Pump price per litre — used ONLY to auto-calculate litres <-> amount in
// the Fuel & Earn UI. This is NOT part of the points earn logic (that's
// exclusively services/rewardEngine.js) — changing a price here has zero
// effect on how many points a litre earns.

// ---- PUMP PRICES (KSh per litre) — update here when prices change ----
const PUMP_PRICES = {
  diesel: 212,
  petrol: 217.86,
};
// ------------------------------------------------------------------

/** Returns a copy so callers can never mutate the constants above. */
function getPumpPrices() {
  return { ...PUMP_PRICES };
}

module.exports = { PUMP_PRICES, getPumpPrices };
