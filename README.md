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
npm run create-admin  # creates your own staff login — you'll be asked for name/phone/password
npm start              # starts the server
```

Then open **http://localhost:3000** in your browser — you'll land on the
"Karibu HASS Nation" welcome page, then a staff login screen. Log in with
the admin account you just created; only after that do you reach the
console (staff console, redemption, analytics — all in one page with
tabs). There's no shared password anymore — every staff member needs
their own login, and every action they take is now tied to their name
(see section 8).

To stop the server, go back to the terminal and press `Ctrl+C`.

## 3. Try it immediately

The seed script created these test cards — use them in the "Find account"
or "Fuel & earn" tabs (once you're logged in):

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

This runs 140+ automated checks against the actual code — individual flat
rate, the 500-point minimum, the 30% cap, fleet tiers climbing correctly,
the rolling 12-month window, the big one (that redeeming points never
lowers a fleet's tier), staff/fleet-manager auth, fleet-to-fleet data
isolation, and the mocked M-Pesa top-up and USSD menu logic from sections
10–11 below. It runs against its own throwaway test database, so it's
always safe to re-run and never touches your real seeded data.

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
│   ├── auth.js              — staff login: bcrypt password checks and
│   │                            session tokens (see section 8 — this is
│   │                            what replaced the old shared API key)
│   ├── mpesaService.js      — M-Pesa Daraja STK push top-up — BUILT, NOT
│   │                            LIVE, see section 10
│   └── ussdService.js       — USSD balance/history menu logic — BUILT,
│                                NOT LIVE, see section 11
├── routes/
│   ├── accounts.js          — create + look up accounts
│   ├── fuel.js               — record a fuel purchase
│   ├── redeem.js             — redeem points
│   ├── analytics.js         — the dashboard summary numbers
│   ├── mpesa.js              — STK push + Safaricom callback endpoints
│   └── ussd.js               — the endpoint a USSD gateway calls
├── public/                  — the actual portal you see in the browser
│   ├── index.html            — "Karibu HASS Nation" welcome page (entry point)
│   ├── login.html            — staff login screen
│   ├── console.html          — the dark staff console (old index.html)
│   ├── styles.css
│   └── app.js               — calls the backend API; contains NO business
│                                logic itself (that all lives in services/)
└── scripts/
    ├── seed.js               — creates the 4 test accounts
    ├── createAdmin.js        — creates the first admin staff login
    ├── simulateMpesaCallback.js — simulates Safaricom's callback locally
    ├── simulateUssd.js       — simulates a phone dialling the USSD menu
    └── test-scenarios.js     — the automated checks (npm test)
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

- **Auth is now per-staff logins** (`services/auth.js`, `staff_users` table)
  — every fuel purchase and redemption records `staff_id`, so you always
  know WHO ran a transaction. Run `npm run create-admin` to create the
  first login. Sessions are a plain bearer token in a `staff_sessions`
  table, good enough for one station on your laptop; if you run multiple
  stations for real, consider shorter session expiry and HTTPS in front
  of this (there's no rate-limiting on the login endpoint itself yet).
- **SQLite is a single file, not built for many people writing at once
  from multiple stations.** Perfect for one laptop today. Before a real
  multi-station pilot, this needs to move to Postgres — the SQL in
  `db/schema.sql` is close to standard SQL already, so this is more of an
  afternoon's work than a rewrite.
- **There's no POS integration yet.** Right now, someone types the litres
  in manually on the "Fuel & earn" screen. Connecting this to real pump
  hardware depends entirely on what your POS vendor can offer — see the
  earlier conversation about that being the real gating factor.

## 10. M-Pesa top-up (Safaricom Daraja) — BUILT, NOT LIVE

Lets a customer top up their points balance directly with cash via M-Pesa
STK push (a prompt on their phone to enter their PIN), credited 1:1 as
points — the "Top-up (M-Pesa)" tab in the console. The full flow is
implemented: `POST /api/mpesa/stkpush` initiates the push,
`POST /api/mpesa/callback/:secret` handles Safaricom's result, and a
successful payment credits `points_ledger` (reason `topup`) exactly like
a fuel purchase does (same 12-month expiry). All of that code path is
exercised by `npm test` — but **it has never talked to the real M-Pesa
network**, and it can't, until two things exist that only you can provide:

1. **Approved Daraja PRODUCTION credentials** — consumer key, consumer
   secret, shortcode, and passkey, from
   [developer.safaricom.co.ke](https://developer.safaricom.co.ke) after
   Safaricom approves a go-live application. Sandbox credentials only
   simulate M-Pesa — they never reach a real phone or move real money,
   but you'd still need them to even exercise the real Daraja HTTP calls.
2. **A publicly reachable HTTPS callback URL** (`MPESA_CALLBACK_URL`) that
   Safaricom's servers can reach from the open internet. This **cannot be
   `localhost`** — use a tool like [ngrok](https://ngrok.com) to get a
   temporary public URL while integration-testing against the Daraja
   sandbox, and your real deployed domain once live.

**Until both exist, leave `MPESA_MOCK=true`** (the default in
`.env.example`) — every field you'd need is there as a clearly-marked
`REPLACE_WITH_...` placeholder in `.env.example`, and setting them to real
values plus `MPESA_MOCK=false` is the entire switch-over; nothing else in
the code needs to change. In mock mode, initiating a top-up never contacts
Safaricom — it records a pending request and hands you back a
`checkoutRequestId`. Resolve it yourself with either:

- the **"Simulate: customer paid" / "Simulate: customer cancelled"**
  buttons that appear in the console right after you send a mock push, or
- `npm run simulate-mpesa-callback -- <checkoutRequestId>` (add `--fail`
  to simulate a cancelled payment) from a terminal.

Both paths run through the exact same `handleCallback()` a real Safaricom
webhook would hit — so the mock isn't a shortcut around the real logic,
it's the real logic fed a fake input, which is also why it's safe to trust
once real credentials are dropped in.

The callback route also isn't wide open: it's protected by a secret path
segment (`MPESA_CALLBACK_SECRET`) since Safaricom can't present a staff
login — see the comments in `routes/mpesa.js` for the one additional
safeguard worth adding in production (an IP allowlist for Safaricom's
published callback ranges).

## 11. USSD balance check — BUILT, NOT LIVE

Lets a customer dial a short code from any phone (no smartphone, no app,
no data connection needed) to check their points balance or recent
activity. `POST /api/ussd` (`routes/ussd.js` → `services/ussdService.js`)
implements the menu logic end-to-end, in the same `CON`/`END` plain-text
request-response convention Africa's Talking's USSD product uses (and
which Safaricom's own USSD gateway, or an aggregator fronting a
Safaricom-leased shortcode, mirrors) — `npm test` exercises it fully.

What it's missing is the one thing no amount of local testing can
substitute for: **an actual USSD shortcode** (something like `*384*7#`)
**leased from Safaricom**, pointed at this endpoint's public URL. That's a
paid, approval-gated process that typically takes **several weeks**, not
something this codebase can shortcut. Until you have one, no real phone
can dial in to this menu at all.

To exercise the exact same menu a real caller would see, with the server
running (`npm start` in another terminal):

```bash
npm run simulate-ussd -- 0711000001
```

(use a phone number that matches one of your seeded/created accounts to
see real balance/history data). It walks the same `CON`/`END` conversation
a phone would, one key-press at a time, against your own running server —
no shortcode, gateway, or telco involved.

## 12. Deploying somewhere real (not just your laptop)

When you're ready to put this on a real URL instead of localhost:

- Any standard Node hosting works: Render, Railway, Fly.io, or a plain
  Linux server all run this exactly as-is.
- Swap SQLite for Postgres first (see section 8).
- Set real environment variables on whatever host you choose — every
  staff login is created via `npm run create-admin` (or by an admin from
  the console) rather than an env var; M-Pesa and SMS credentials still
  go in the environment (see sections 7 and 10). Never commit `.env`
  itself anywhere.
