// scripts/seed.js
// Creates a few starter accounts so you have something to look up
// immediately after starting the server for the first time.

const db = require('../db');

const accounts = [
  { card_code: 'CAP-0001', type: 'individual', name: 'John K.', phone: '0711000001', rank: 'captain', vehicle_type: 'boda_boda' },
  { card_code: 'WAR-0001', type: 'individual', name: 'Abel M.', phone: '0711000002', rank: 'warrior', vehicle_type: 'personal_car' },
  { card_code: 'FLEET-OCHIENG', type: 'fleet', name: 'Ochieng Logistics', phone: '0711000003', rank: 'commander', vehicle_type: 'long_haul_fleet' },
  { card_code: 'SACCO-KILIMANI', type: 'fleet', name: 'Kilimani Boda Sacco', phone: '0711000004', rank: 'captain', vehicle_type: 'boda_boda' },
];

const insert = db.prepare(`
  INSERT OR IGNORE INTO accounts (card_code, type, name, phone, rank, vehicle_type)
  VALUES (@card_code, @type, @name, @phone, @rank, @vehicle_type)
`);

for (const a of accounts) insert.run(a);

console.log(`Seeded ${accounts.length} accounts (skipped any that already exist):`);
accounts.forEach(a => console.log(`  ${a.card_code} — ${a.name} (${a.type})`));
