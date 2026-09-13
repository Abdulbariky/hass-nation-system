// public/app.js
// This file only talks to OUR OWN backend (server.js / routes/*.js) — it
// never contains business logic itself. If a rule ever looks wrong here,
// the bug is in the backend, not this file. That separation is deliberate.

// ---- Session (services/auth.js on the backend is the real gatekeeper —
// this is just how the browser carries the token it issued at login) ----
function getToken() { return localStorage.getItem('hn_token'); }
function getStaff() {
  try { return JSON.parse(localStorage.getItem('hn_staff') || 'null'); } catch { return null; }
}
function clearSession() {
  localStorage.removeItem('hn_token');
  localStorage.removeItem('hn_staff');
}

async function api(path, options = {}) {
  const res = await fetch(`/api${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${getToken() || ''}`,
      ...(options.headers || {}),
    },
  });
  if (res.status === 401) {
    clearSession();
    location.href = 'login.html';
    return { ok: false, status: 401, data: { error: 'Login required' } };
  }
  const data = await res.json();
  return { ok: res.ok, status: res.status, data };
}

// ---- Staff bar ----
const currentStaff = getStaff();
const staffNameEl = document.getElementById('staff-name');
if (staffNameEl && currentStaff) {
  staffNameEl.textContent = `${currentStaff.name} · ${currentStaff.role}${currentStaff.station ? ' · ' + currentStaff.station : ''}`;
}
document.getElementById('btn-logout')?.addEventListener('click', async () => {
  await api('/auth/logout', { method: 'POST' });
  clearSession();
  location.href = 'login.html';
});

// ---- Tab switching ----
document.querySelectorAll('nav.tabs button').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('section.screen').forEach(s => s.classList.remove('active'));
    document.querySelectorAll('nav.tabs button').forEach(b => b.classList.remove('active'));
    document.getElementById('screen-' + btn.dataset.screen).classList.add('active');
    btn.classList.add('active');
    if (btn.dataset.screen === 'analytics') loadAnalytics();
  });
});

// ---- Account lookup (shared) ----
// A single box accepts either a card code (letters/digits/hyphens, e.g.
// CAP-0001) or a phone number (mostly digits) — we work out which by
// shape, then hit the matching lookup endpoint. Used by both the "Find
// account" screen and "Fuel & earn".
function looksLikePhone(value) {
  return /^\+?\d{7,15}$/.test(value.replace(/[\s-]/g, ''));
}

async function lookupAccount(raw) {
  return looksLikePhone(raw)
    ? api(`/accounts/by-phone/${encodeURIComponent(raw.replace(/[\s-]/g, ''))}`)
    : api(`/accounts/by-code/${encodeURIComponent(raw)}`);
}

// ---- Find account ----
document.getElementById('btn-lookup').addEventListener('click', async () => {
  const raw = document.getElementById('lookup-code').value.trim();
  const resultBox = document.getElementById('account-result');
  resultBox.innerHTML = '';
  if (!raw) return;

  const found = await lookupAccount(raw);
  if (!found.ok) {
    resultBox.innerHTML = `<div class="result-msg err">${found.data.error || 'Account not found'}</div>`;
    return;
  }
  renderAccount(found.data, resultBox);

  const tx = await api(`/accounts/${found.data.id}/transactions`);
  if (tx.ok) renderTransactions(tx.data, resultBox);
});

function renderAccount(acct, container) {
  const tierBlock = acct.tier
    ? `<div class="stat"><div class="num">${acct.tier.currentRate} pts/L</div><div class="lbl">Current fleet rate (${acct.tier.trailingLitres.toLocaleString()} L trailing 12mo)</div></div>`
    : '';
  const fleetMeta = acct.type === 'fleet' && acct.organisation_name
    ? `<div class="meta">${acct.organisation_name}${acct.location ? ' · ' + acct.location : ''}${acct.contact_person_name ? ' · contact: ' + acct.contact_person_name + (acct.contact_person_phone ? ' (' + acct.contact_person_phone + ')' : '') : ''}</div>`
    : '';
  container.innerHTML = `
    <div class="acct-card">
      <div class="name">${acct.name}</div>
      <div class="meta">${acct.card_code} · ${acct.type} ${acct.rank ? '· ' + acct.rank : ''} ${acct.vehicle_type ? '· ' + acct.vehicle_type : ''}</div>
      ${fleetMeta}
      <div class="stat-row">
        <div class="stat"><div class="num">${Math.round(acct.balance).toLocaleString()}</div><div class="lbl">Points balance</div></div>
        ${tierBlock}
      </div>
    </div>`;
}

function renderTransactions(rows, container) {
  if (!rows.length) return;
  const body = rows.slice(0, 15).map(r => {
    if (r.kind === 'fuel') {
      return `<tr><td>${new Date(r.created_at).toLocaleDateString()}</td><td>Fuelled ${r.litres}L (${r.fuel_type})</td><td style="color:var(--good)">+${Math.round(r.points_earned)}</td></tr>`;
    }
    return `<tr><td>${new Date(r.created_at).toLocaleDateString()}</td><td>Redeemed at pump</td><td style="color:var(--amber)">−${Math.round(r.points_requested)}</td></tr>`;
  }).join('');
  container.innerHTML += `<table><thead><tr><th>Date</th><th>Activity</th><th>Points</th></tr></thead><tbody>${body}</tbody></table>`;
}

// ---- New account (two-step: enter details -> verify OTP -> created) ----
const naType = document.getElementById('na-type');
const naFleetFields = document.getElementById('na-fleet-fields');
const naStepDetails = document.getElementById('na-step-details');
const naStepOtp = document.getElementById('na-step-otp');
const naStepDone = document.getElementById('na-step-done');

function updateFleetFieldsVisibility() {
  naFleetFields.hidden = naType.value !== 'fleet';
}
naType.addEventListener('change', updateFleetFieldsVisibility);
updateFleetFieldsVisibility();

let pendingAccount = null;

function resetNewAccountFlow() {
  pendingAccount = null;
  naStepDetails.hidden = false;
  naStepOtp.hidden = true;
  naStepDone.hidden = true;
  document.getElementById('na-otp-code').value = '';
  document.getElementById('na-details-result').textContent = '';
  document.getElementById('na-otp-result').textContent = '';
}

document.getElementById('btn-send-otp').addEventListener('click', async () => {
  const box = document.getElementById('na-details-result');
  const phone = document.getElementById('na-phone').value.trim();
  const name = document.getElementById('na-name').value.trim();
  if (!name || !phone) {
    box.className = 'result-msg err';
    box.textContent = 'Name and phone are required';
    return;
  }

  pendingAccount = {
    type: naType.value,
    name,
    phone,
    vehicleType: document.getElementById('na-vehicle-type').value,
    organisationName: document.getElementById('na-org').value.trim(),
    location: document.getElementById('na-location').value.trim(),
    contactPersonName: document.getElementById('na-contact-name').value.trim(),
    contactPersonPhone: document.getElementById('na-contact-phone').value.trim(),
  };

  const result = await api('/otp/send', { method: 'POST', body: JSON.stringify({ phone }) });
  if (!result.ok) {
    box.className = 'result-msg err';
    box.textContent = result.data.error || 'Could not send verification code';
    return;
  }

  box.textContent = '';
  document.getElementById('na-otp-phone').textContent = phone;
  naStepDetails.hidden = true;
  naStepOtp.hidden = false;
});

document.getElementById('btn-otp-back').addEventListener('click', () => {
  naStepOtp.hidden = true;
  naStepDetails.hidden = false;
});

document.getElementById('btn-verify-otp').addEventListener('click', async () => {
  const box = document.getElementById('na-otp-result');
  const code = document.getElementById('na-otp-code').value.trim();
  if (!pendingAccount) return;

  const verify = await api('/otp/verify', { method: 'POST', body: JSON.stringify({ phone: pendingAccount.phone, code }) });
  if (!verify.ok) {
    box.className = 'result-msg err';
    box.textContent = verify.data.error || 'Verification failed';
    return;
  }

  const result = await api('/accounts', { method: 'POST', body: JSON.stringify(pendingAccount) });
  if (!result.ok) {
    box.className = 'result-msg err';
    box.textContent = result.data.error;
    return;
  }

  naStepOtp.hidden = true;
  naStepDone.hidden = false;
  document.getElementById('na-done-result').textContent =
    `Account created: ${result.data.card_code} (${result.data.type}, ${result.data.rank})`;
});

document.getElementById('btn-na-another').addEventListener('click', resetNewAccountFlow);

// ---- Fuel & earn ----
// Pump prices drive the litres <-> amount auto-fill; fetched once from the
// backend (services/pumpPriceService.js) so the UI never hardcodes them.
let pumpPrices = { petrol: 217.86, diesel: 212 };
api('/config/prices').then(r => { if (r.ok) pumpPrices = r.data; });

const fuelCodeInput = document.getElementById('fuel-code');
const fuelTypeSelect = document.getElementById('fuel-type');
const fuelLitresInput = document.getElementById('fuel-litres');
const fuelAmountInput = document.getElementById('fuel-amount');
const fuelPreviewBox = document.getElementById('fuel-preview');
const fuelVehicleField = document.getElementById('fuel-vehicle-field');
const fuelVehicleSelect = document.getElementById('fuel-vehicle');

let fuelAccountId = null;
let fuelLastEdited = null; // 'litres' | 'amount' — whichever field the attendant typed most recently wins

// Fleet accounts only — which of their vehicles (if any) this fill-up was
// for. Purely optional and purely descriptive; never affects the earn rate.
async function loadFuelVehicleOptions(accountId) {
  fuelVehicleSelect.innerHTML = '<option value="">— not specified —</option>';
  const result = await api(`/accounts/${encodeURIComponent(accountId)}/vehicles`);
  if (!result.ok || !result.data.length) {
    fuelVehicleField.hidden = true;
    return;
  }
  result.data.filter(v => v.active).forEach(v => {
    const option = document.createElement('option');
    option.value = v.id;
    option.textContent = v.registration_number + (v.driver_name ? ` — ${v.driver_name}` : '');
    fuelVehicleSelect.appendChild(option);
  });
  fuelVehicleField.hidden = false;
}

function currentPumpPrice() {
  return pumpPrices[fuelTypeSelect.value];
}

function recalcAmountFromLitres() {
  const litres = parseFloat(fuelLitresInput.value);
  if (!isNaN(litres)) fuelAmountInput.value = (litres * currentPumpPrice()).toFixed(2);
}

function recalcLitresFromAmount() {
  const amount = parseFloat(fuelAmountInput.value);
  if (!isNaN(amount)) fuelLitresInput.value = (amount / currentPumpPrice()).toFixed(2);
}

async function loadFuelPreview() {
  const litres = parseFloat(fuelLitresInput.value);
  if (!fuelAccountId || isNaN(litres) || litres <= 0) {
    fuelPreviewBox.textContent = '';
    return;
  }
  const preview = await api(`/fuel/preview?accountId=${encodeURIComponent(fuelAccountId)}&litres=${encodeURIComponent(litres)}`);
  if (!preview.ok) return;
  fuelPreviewBox.className = 'result-msg';
  fuelPreviewBox.textContent = `This will earn ${Math.round(preview.data.pointsEarned)} points at ${preview.data.ratePerLitre} points/litre${preview.data.tierLabel ? ' (tier: ' + preview.data.tierLabel + ')' : ''}.`;
}

fuelLitresInput.addEventListener('input', () => {
  fuelLastEdited = 'litres';
  recalcAmountFromLitres();
  loadFuelPreview();
});

fuelAmountInput.addEventListener('input', () => {
  fuelLastEdited = 'amount';
  recalcLitresFromAmount();
  loadFuelPreview();
});

// Fuel type changes the pump price — re-derive whichever field ISN'T the
// one the attendant is authoring, so their last edit stays authoritative.
fuelTypeSelect.addEventListener('change', () => {
  if (fuelLastEdited === 'amount') recalcLitresFromAmount();
  else recalcAmountFromLitres();
  loadFuelPreview();
});

fuelCodeInput.addEventListener('change', async () => {
  fuelAccountId = null;
  fuelPreviewBox.className = 'result-msg';
  fuelPreviewBox.textContent = '';
  fuelVehicleField.hidden = true;
  fuelVehicleSelect.innerHTML = '<option value="">— not specified —</option>';
  const raw = fuelCodeInput.value.trim();
  if (!raw) return;

  const account = await lookupAccount(raw);
  if (!account.ok) {
    fuelPreviewBox.className = 'result-msg err';
    fuelPreviewBox.textContent = account.data.error || 'Account not found';
    return;
  }
  fuelAccountId = account.data.id;
  loadFuelPreview();
  if (account.data.type === 'fleet') loadFuelVehicleOptions(fuelAccountId);
});

document.getElementById('btn-fuel').addEventListener('click', async () => {
  const box = document.getElementById('fuel-result');
  const raw = fuelCodeInput.value.trim();
  const account = fuelAccountId ? { ok: true, data: { id: fuelAccountId } } : await lookupAccount(raw);
  if (!account.ok) { box.className = 'result-msg err'; box.textContent = account.data.error; return; }

  const body = {
    accountId: account.data.id,
    litres: fuelLitresInput.value,
    fuelType: fuelTypeSelect.value,
    station: document.getElementById('fuel-station').value.trim(),
    amountKsh: fuelAmountInput.value,
    vehicleId: fuelVehicleSelect.value || null,
  };
  const result = await api('/fuel', { method: 'POST', body: JSON.stringify(body) });
  box.className = 'result-msg ' + (result.ok ? 'ok' : 'err');
  box.textContent = result.ok
    ? `+${Math.round(result.data.pointsEarned)} points at ${result.data.ratePerLitre} pts/L${result.data.tierLabel ? ' (tier: ' + result.data.tierLabel + ')' : ''}. New balance: ${Math.round(result.data.newBalance)}.`
    : result.data.error;
});

// ---- Redeem ----
// Shows the ceiling (500 min / 30% cap, whichever bites) BEFORE the
// customer types a points value, from GET /accounts/:id/redeemable — the
// server's redemptionEngine.js is still the only place that actually
// enforces those rules; this is a preview, not a second copy of them.
const redeemCodeInput = document.getElementById('redeem-code');
const redeemInvoiceInput = document.getElementById('redeem-invoice');
const redeemPointsInput = document.getElementById('redeem-points');
const redeemableBox = document.getElementById('redeem-redeemable');
const redeemWorthBox = document.getElementById('redeem-worth');

let redeemAccountId = null;
let redeemMaxPoints = 0;

function fuelWorthText(points) {
  const ksh = Math.round(points);
  const parts = [];
  if (pumpPrices.diesel) parts.push(`${(points / pumpPrices.diesel).toFixed(1)} L of diesel`);
  if (pumpPrices.petrol) parts.push(`${(points / pumpPrices.petrol).toFixed(1)} L of petrol`);
  return `${Math.round(points).toLocaleString()} points = KSh ${ksh.toLocaleString()} = about ${parts.join(' or ')}.`;
}

function updateRedeemWorth() {
  const typed = parseFloat(redeemPointsInput.value);
  const points = typed > 0 ? typed : redeemMaxPoints;
  redeemWorthBox.textContent = points > 0 ? fuelWorthText(points) : '';
}

// The UI caps what can be typed, but the server re-checks everything from
// scratch on submit — this is a convenience, never the actual guardrail.
function clampRedeemPoints() {
  const typed = parseFloat(redeemPointsInput.value);
  if (!isNaN(typed) && typed > redeemMaxPoints) {
    redeemPointsInput.value = redeemMaxPoints;
  }
}

async function loadRedeemable() {
  redeemableBox.className = 'result-msg';
  redeemableBox.textContent = '';
  redeemMaxPoints = 0;
  redeemPointsInput.removeAttribute('max');

  const invoice = parseFloat(redeemInvoiceInput.value);
  if (!redeemAccountId || isNaN(invoice) || invoice <= 0) {
    updateRedeemWorth();
    return;
  }

  const result = await api(`/accounts/${encodeURIComponent(redeemAccountId)}/redeemable?invoiceAmount=${encodeURIComponent(invoice)}`);
  if (!result.ok) {
    redeemableBox.className = 'result-msg err';
    redeemableBox.textContent = result.data.error || 'Could not check redeemable points';
    updateRedeemWorth();
    return;
  }

  redeemMaxPoints = Math.floor(result.data.maxRedeemable);
  if (redeemMaxPoints > 0) {
    redeemPointsInput.max = redeemMaxPoints;
    redeemableBox.textContent = `You can redeem up to ${redeemMaxPoints.toLocaleString()} points (KSh ${redeemMaxPoints.toLocaleString()}).`;
  } else {
    redeemableBox.className = 'result-msg err';
    redeemableBox.textContent = result.data.reason || 'No points can be redeemed on this invoice right now.';
  }
  clampRedeemPoints();
  updateRedeemWorth();
}

redeemCodeInput.addEventListener('change', async () => {
  redeemAccountId = null;
  const raw = redeemCodeInput.value.trim();
  if (!raw) { loadRedeemable(); return; }

  const account = await lookupAccount(raw);
  if (!account.ok) {
    redeemableBox.className = 'result-msg err';
    redeemableBox.textContent = account.data.error || 'Account not found';
    return;
  }
  redeemAccountId = account.data.id;
  loadRedeemable();
});

redeemInvoiceInput.addEventListener('input', loadRedeemable);
redeemPointsInput.addEventListener('input', () => {
  clampRedeemPoints();
  updateRedeemWorth();
});

document.getElementById('btn-redeem').addEventListener('click', async () => {
  const box = document.getElementById('redeem-result');
  const raw = redeemCodeInput.value.trim();
  const account = redeemAccountId ? { ok: true, data: { id: redeemAccountId } } : await lookupAccount(raw);
  if (!account.ok) { box.className = 'result-msg err'; box.textContent = account.data.error; return; }

  const body = {
    accountId: account.data.id,
    invoiceAmount: redeemInvoiceInput.value,
    pointsRequested: redeemPointsInput.value,
  };
  const result = await api('/redeem', { method: 'POST', body: JSON.stringify(body) });
  box.className = 'result-msg ' + (result.data.status === 'approved' ? 'ok' : 'err');
  box.textContent = result.data.status === 'approved'
    ? `Applied. New invoice: KSh ${Math.round(result.data.newInvoiceTotal).toLocaleString()}. Balance: ${Math.round(result.data.newBalance)} points.`
    : result.data.rejectionReason;

  if (result.data.status === 'approved') loadRedeemable(); // balance moved — refresh the ceiling
});

// ---- Top-up via M-Pesa (built, not live — see README "M-Pesa top-up") ----
let pendingTopupCheckoutId = null;

document.getElementById('btn-topup-send').addEventListener('click', async () => {
  const box = document.getElementById('topup-result');
  const pendingBox = document.getElementById('topup-pending');
  pendingBox.hidden = true;
  pendingTopupCheckoutId = null;

  const raw = document.getElementById('topup-code').value.trim();
  const account = await lookupAccount(raw);
  if (!account.ok) { box.className = 'result-msg err'; box.textContent = account.data.error; return; }

  const body = {
    accountId: account.data.id,
    phone: document.getElementById('topup-phone').value.trim(),
    amount: document.getElementById('topup-amount').value,
  };
  const result = await api('/mpesa/stkpush', { method: 'POST', body: JSON.stringify(body) });
  box.className = 'result-msg ' + (result.ok ? 'ok' : 'err');
  box.textContent = result.ok
    ? `STK push ${result.data.mock ? '(mocked) ' : ''}sent — checkout ${result.data.checkoutRequestId}.`
    : result.data.error;

  if (result.ok && result.data.mock) {
    pendingTopupCheckoutId = result.data.checkoutRequestId;
    document.getElementById('topup-pending-note').textContent = result.data.note;
    document.getElementById('topup-simulate-result').textContent = '';
    pendingBox.hidden = false;
  }
});

async function simulateTopup(succeed) {
  const box = document.getElementById('topup-simulate-result');
  if (!pendingTopupCheckoutId) return;
  const result = await api('/mpesa/simulate-callback', { method: 'POST', body: JSON.stringify({ checkoutRequestId: pendingTopupCheckoutId, succeed }) });
  box.className = 'result-msg ' + (result.ok ? 'ok' : 'err');
  box.textContent = result.ok
    ? (result.data.status === 'completed'
        ? `Simulated payment completed — ${Math.round(result.data.pointsCredited)} points credited.`
        : 'Simulated cancellation recorded — no points credited.')
    : result.data.error;
}
document.getElementById('btn-topup-simulate-success').addEventListener('click', () => simulateTopup(true));
document.getElementById('btn-topup-simulate-fail').addEventListener('click', () => simulateTopup(false));

// ---- Analytics ----
async function loadAnalytics() {
  const result = await api('/analytics/summary');
  const box = document.getElementById('analytics-body');
  if (!result.ok) { box.innerHTML = `<div class="result-msg err">Could not load analytics</div>`; return; }
  const d = result.data;
  box.innerHTML = `
    <div class="stat-row">
      <div class="stat"><div class="num">${d.totalLitres.toLocaleString()}</div><div class="lbl">Total litres sold</div></div>
      <div class="stat"><div class="num">KSh ${Math.round(d.totalRevenueKsh).toLocaleString()}</div><div class="lbl">Total revenue</div></div>
      <div class="stat"><div class="num">${Math.round(d.totalPointsIssued).toLocaleString()}</div><div class="lbl">Points issued</div></div>
      <div class="stat"><div class="num">${Math.round(d.outstandingPointsLiability).toLocaleString()}</div><div class="lbl">Outstanding points liability</div></div>
    </div>
    <table>
      <thead><tr><th>Station</th><th>Fill-ups</th><th>Litres</th></tr></thead>
      <tbody>${d.byStation.map(s => `<tr><td>${s.station}</td><td>${s.fillUps}</td><td>${s.litres.toLocaleString()}</td></tr>`).join('') || '<tr><td colspan="3">No data yet</td></tr>'}</tbody>
    </table>`;
}
