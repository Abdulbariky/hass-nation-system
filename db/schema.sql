-- HASS NATION — database schema
-- Every table here maps directly to a rule we agreed on in planning.

-- One row per card / account. type decides which earn track applies.
CREATE TABLE IF NOT EXISTS accounts (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  card_code     TEXT UNIQUE NOT NULL,       -- printed/encoded ID on the physical card
  type          TEXT NOT NULL CHECK (type IN ('individual', 'fleet')),
  name          TEXT NOT NULL,
  phone         TEXT,
  rank          TEXT,                       -- captain / warrior / commander — identity only, not used in earn maths
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

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
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

-- The points wallet. Every earn and every redemption is a row here —
-- balance is always SUM(delta), never a field we update directly, so the
-- ledger can always be audited and can never silently drift from reality.
CREATE TABLE IF NOT EXISTS points_ledger (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id      INTEGER NOT NULL REFERENCES accounts(id),
  delta           REAL NOT NULL,             -- positive = earned, negative = redeemed
  reason          TEXT NOT NULL,             -- 'fuel_purchase' | 'redemption' | 'expiry' | 'adjustment'
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
  created_at        TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_fuel_account ON fuel_transactions(account_id, created_at);
CREATE INDEX IF NOT EXISTS idx_ledger_account ON points_ledger(account_id, created_at);
