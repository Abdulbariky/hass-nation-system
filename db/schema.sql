-- HASS NATION — database schema
-- Every table here maps directly to a rule we agreed on in planning.

-- One row per card / account. type decides which earn track applies.
-- rank and vehicle_type are IDENTITY ONLY — see services/rewardEngine.js
-- for the one and only thing that decides points rates (account type).
CREATE TABLE IF NOT EXISTS accounts (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  card_code             TEXT UNIQUE NOT NULL,       -- auto-generated server-side, e.g. CAP-00001
  type                  TEXT NOT NULL CHECK (type IN ('individual', 'fleet')),
  name                  TEXT NOT NULL,
  phone                 TEXT,
  rank                  TEXT,                       -- captain / warrior / commander — derived from vehicle_type, identity only
  vehicle_type          TEXT,                       -- e.g. boda_boda, truck — decides rank, never the earn rate
  organisation_name     TEXT,                       -- fleet accounts only
  location              TEXT,                       -- fleet accounts only
  contact_person_name   TEXT,                       -- fleet accounts only
  contact_person_phone  TEXT,                       -- fleet accounts only
  created_at            TEXT NOT NULL DEFAULT (datetime('now'))
);

-- One row per OTP code issued. A phone must have a consumed, unexpired
-- verification here before an account can be created for it.
CREATE TABLE IF NOT EXISTS otp_verifications (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  phone         TEXT NOT NULL,
  code          TEXT NOT NULL,
  expires_at    TEXT NOT NULL,
  consumed      INTEGER NOT NULL DEFAULT 0,
  attempts      INTEGER NOT NULL DEFAULT 0, -- verify attempts made against this row, for the 5-per-phone-per-hour cap
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_otp_phone ON otp_verifications(phone, created_at);

-- Staff logins — replaces the old single shared API key. Every write the
-- console makes is now tied to whichever staff_users row is behind the
-- session token, not just "someone who had the password."
CREATE TABLE IF NOT EXISTS staff_users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  name          TEXT NOT NULL,
  phone         TEXT UNIQUE,
  email         TEXT UNIQUE,
  password_hash TEXT NOT NULL,              -- bcrypt, never the plaintext password
  role          TEXT NOT NULL CHECK (role IN ('attendant', 'admin')),
  station       TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

-- A logged-in session — one bearer token per login, expiring on its own.
CREATE TABLE IF NOT EXISTS staff_sessions (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  token         TEXT UNIQUE NOT NULL,
  staff_id      INTEGER NOT NULL REFERENCES staff_users(id),
  expires_at    TEXT NOT NULL,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_sessions_token ON staff_sessions(token);

-- One row per vehicle registered under a FLEET account. Purely descriptive
-- (which of my trucks fuelled up) — never used in points maths, and
-- individual accounts don't have any.
CREATE TABLE IF NOT EXISTS vehicles (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id            INTEGER NOT NULL REFERENCES accounts(id),
  registration_number   TEXT NOT NULL,
  vehicle_type          TEXT,
  driver_name           TEXT,
  driver_phone          TEXT,
  active                INTEGER NOT NULL DEFAULT 1,
  created_at            TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_vehicles_account ON vehicles(account_id);

-- Fleet manager login sessions — separate from staff_sessions, and bound
-- to an ACCOUNT rather than a person: login is "the contact person for
-- THIS fleet account", proved by an OTP to a phone already on file for
-- it (services/otpService.js), not a password. Every fleet-dashboard
-- route trusts ONLY the account_id bound here — never anything the
-- client sends — which is what keeps one fleet from seeing another's data.
CREATE TABLE IF NOT EXISTS fleet_sessions (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  token         TEXT UNIQUE NOT NULL,
  account_id    INTEGER NOT NULL REFERENCES accounts(id),
  phone         TEXT NOT NULL,
  expires_at    TEXT NOT NULL,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_fleet_sessions_token ON fleet_sessions(token);

-- One row per fuel purchase. This is the source of truth for both the
-- points earned AND (for fleet accounts) the rolling 12-month litre count
-- that decides their tier. We never store "current tier" as a field on the
-- account — it's always recalculated from this table, so it can never go
-- stale or get out of sync.
CREATE TABLE IF NOT EXISTS fuel_transactions (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id      INTEGER NOT NULL REFERENCES accounts(id),
  litres          REAL NOT NULL,
  fuel_type       TEXT NOT NULL CHECK (fuel_type IN ('petrol', 'diesel')),
  station         TEXT,
  amount_ksh      REAL NOT NULL,             -- real cash value of the fill-up (litres x pump price)
  rate_per_litre  REAL NOT NULL,             -- points/litre actually applied to this transaction
  points_earned   REAL NOT NULL,
  tier_at_time    TEXT,                      -- which fleet tier was active when this was earned (null for individuals)
  staff_id        INTEGER REFERENCES staff_users(id), -- WHO ran this transaction
  vehicle_id      INTEGER REFERENCES vehicles(id),    -- optional: which fleet vehicle this fill-up was for
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

-- The points wallet. Every earn and every redemption is a row here —
-- balance is always SUM(delta), never a field we update directly, so the
-- ledger can always be audited and can never silently drift from reality.
CREATE TABLE IF NOT EXISTS points_ledger (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id      INTEGER NOT NULL REFERENCES accounts(id),
  delta           REAL NOT NULL,             -- positive = earned, negative = redeemed
  reason          TEXT NOT NULL,             -- 'fuel_purchase' | 'redemption' | 'expiry' | 'adjustment' | 'topup'
  reference_id    INTEGER,                   -- fuel_transactions.id or redemptions.id, for traceability
  expires_at      TEXT,                      -- only set on positive (earn) rows — 12 months after created_at
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

-- One row per redemption attempt (including rejected ones, for audit trail).
CREATE TABLE IF NOT EXISTS redemptions (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id        INTEGER NOT NULL REFERENCES accounts(id),
  invoice_amount    REAL NOT NULL,
  points_requested  REAL NOT NULL,
  status            TEXT NOT NULL CHECK (status IN ('approved', 'rejected')),
  rejection_reason  TEXT,
  new_invoice_total REAL,
  staff_id          INTEGER REFERENCES staff_users(id), -- WHO ran this redemption
  created_at        TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_fuel_account ON fuel_transactions(account_id, created_at);
CREATE INDEX IF NOT EXISTS idx_ledger_account ON points_ledger(account_id, created_at);

-- One row per M-Pesa STK Push top-up attempt (including failed/cancelled
-- ones, for audit trail — mirrors the redemptions table's approach).
-- THIS FEATURE IS BUILT BUT NOT LIVE — see README "M-Pesa top-up" for the
-- real Daraja credentials and public callback URL it still needs.
CREATE TABLE IF NOT EXISTS mpesa_transactions (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id            INTEGER NOT NULL REFERENCES accounts(id),
  phone                 TEXT NOT NULL,             -- M-Pesa phone number charged
  amount                REAL NOT NULL,             -- KSh requested
  checkout_request_id   TEXT UNIQUE,               -- Daraja's id for this STK push (or a MOCK-prefixed one)
  merchant_request_id   TEXT,
  status                TEXT NOT NULL CHECK (status IN ('pending', 'completed', 'failed')) DEFAULT 'pending',
  result_code           INTEGER,                   -- Daraja ResultCode from the callback (0 = success)
  result_desc           TEXT,
  mpesa_receipt_number  TEXT,                      -- only set once Safaricom confirms payment
  points_credited       REAL,                      -- only set once completed
  mock                  INTEGER NOT NULL DEFAULT 0, -- 1 if MPESA_MOCK simulated this — never sent to Safaricom
  created_at            TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at            TEXT
);

CREATE INDEX IF NOT EXISTS idx_mpesa_checkout ON mpesa_transactions(checkout_request_id);
