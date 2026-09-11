# HASS NATION — Points System

A working backend + portal for the loyalty points system we designed:
individual drivers on a flat rate, fleets/saccos on a tiered rolling
12-month rate, redemption capped and gated the way we agreed. Runs
entirely on your laptop — no cloud account needed to try it today.

## 1. Before you start

You need **Node.js** installed (version 18 or newer). Check with:

```
node --version
```

If that command isn't found, install Node from https://nodejs.org (the
"LTS" version) — it's a standard installer, next-next-finish.

## 2. Setup — run these commands in order, from inside this folder

```bash
npm install          # downloads the packages this project depends on
cp .env.example .env  # your local configuration file (Mac/Linux)
# on Windows, instead: copy .env.example .env
npm run seed          # creates 4 starter accounts so you have something to look up
npm start              # starts the server
```

Then open **http://localhost:3000** in your browser. That's the whole
system — staff console, redemption, analytics — all in one page with tabs.

To stop the server, go back to the terminal and press `Ctrl+C`.

## 3. Try it immediately

The seed script created these test cards — use them in the "Find account"
or "Fuel & earn" tabs:

| Card code | Type | Name |
|---|---|---|
| `CAP-0001` | individual | John K. |
| `WAR-0001` | individual | Abel M. |
| `FLEET-OCHIENG` | fleet | Ochieng Logistics |
| `SACCO-KILIMANI` | fleet | Kilimani Boda Sacco |

Try: go to **Fuel & earn**, enter `FLEET-OCHIENG`, 32000 litres, diesel,
any station, amount KSh 6,784,000 → record it → go to **Find account**,
look up `FLEET-OCHIENG` again, and you'll see the tier and balance updated
live.

## 4. Prove the business logic is correct

```bash
npm test
```

This runs 22 automated checks against the actual code — individual flat
rate, the 500-point minimum, the 30% cap, fleet tiers climbing correctly,
the rolling 12-month window, and the big one: that redeeming points never
lowers a fleet's tier. It runs against its own throwaway test database, so
it's always safe to re-run and never touches your real seeded data.

## 5. What's in this folder, and why

```
hass-nation-system/
├── server.js              — starts everything, wires the routes together
├── db/
│   ├── schema.sql          — the 4 tables: accounts, fuel_transactions,
│   │                          points_ledger, redemptions
│   └── index.js             — opens the database file, loads the schema
├── services/
│   ├── rewardEngine.js      — ⭐ THE EARN LOGIC. Individual flat rate,
│   │                          fleet tiers, the rolling 12-month window.
│   │                          If a rate ever changes, this is the file.
│   ├── redemptionEngine.js  — ⭐ THE REDEMPTION LOGIC. 500 minimum, 30%
│   │                          cap, and why redeeming never touches a
│   │                          fleet's tier.
│   ├── smsService.js        — sends confirmation texts. Currently just
│   │                          prints to the terminal — see section 7 below
│   │                          to connect a real SMS provider.
│   └── auth.js              — the staff API key check (see section 8 —
│                                this needs hardening before real use)
├── routes/
│   ├── accounts.js          — create + look up accounts
│   ├── fuel.js               — record a fuel purchase
│   ├── redeem.js             — redeem points
│   └── analytics.js         — the dashboard summary numbers
├── public/                  — the actual portal you see in the browser
│   ├── index.html
│   ├── styles.css
│   └── app.js               — calls the backend API; contains NO business
│                                logic itself (that all lives in services/)
└── scripts/
    ├── seed.js               — creates the 4 test accounts
    └── test-scenarios.js     — the 22 automated checks
```

**The rule to remember:** all the actual money-and-points decisions live
in exactly two files — `services/rewardEngine.js` and
`services/redemptionEngine.js`. Everything else (routes, frontend) is
just plumbing that calls those two files. If something about the points
math ever looks wrong, start there — nowhere else.

## 6. If a rate ever needs to change

Open `services/rewardEngine.js`. Near the top:

```js
const INDIVIDUAL_RATE = 2; // points per litre

const FLEET_TIERS = [
  { min: 100000, rate: 7 },
  { min: 70000,  rate: 6 },
  { min: 30000,  rate: 5 },
  { min: 0,      rate: 4 },
];
```

Change a number, save, restart the server (`Ctrl+C` then `npm start`
again). That's it — every calculation in the system reads from these two
constants, nothing is hard-coded anywhere else.

## 7. Connecting real SMS (Africa's Talking)

Right now every confirmation text just prints to your terminal — you can
see this happening in the server's output when you record a fuel purchase.
To send real texts:

1. Create an account at https://africastalking.com
2. `npm install africastalking`
3. Open `services/smsService.js` — there's a clearly marked TODO block
   with the exact code to uncomment
4. Add your API key and username to `.env`
5. Set `SMS_PROVIDER=africastalking` in `.env`

## 8. Before this touches real money at a real station

Three things this version deliberately simplifies, flagged so nothing
gets forgotten:

- **Auth is a single shared password** (`services/auth.js`), not per-staff
  logins. Fine for you testing on your laptop today; replace with real
  per-attendant accounts before pump staff are using this with actual
  customers, so you know WHO ran every transaction.
- **SQLite is a single file, not built for many people writing at once
  from multiple stations.** Perfect for one laptop today. Before a real
  multi-station pilot, this needs to move to Postgres — the SQL in
  `db/schema.sql` is close to standard SQL already, so this is more of an
  afternoon's work than a rewrite.
- **There's no POS integration yet.** Right now, someone types the litres
  in manually on the "Fuel & earn" screen. Connecting this to real pump
  hardware depends entirely on what your POS vendor can offer — see the
  earlier conversation about that being the real gating factor.

## 9. Deploying somewhere real (not just your laptop)

When you're ready to put this on a real URL instead of localhost:

- Any standard Node hosting works: Render, Railway, Fly.io, or a plain
  Linux server all run this exactly as-is.
- Swap SQLite for Postgres first (see section 8).
- Set real environment variables (`STAFF_API_KEY`, SMS credentials) on
  whatever host you choose — never commit `.env` itself anywhere.
