// public/app.js
// This file only talks to OUR OWN backend (server.js / routes/*.js) — it
// never contains business logic itself. If a rule ever looks wrong here,
// the bug is in the backend, not this file. That separation is deliberate.

const API_KEY = 'dev-key-change-me'; // must match STAFF_API_KEY in your .env

async function api(path, options = {}) {
  const res = await fetch(`/api${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': API_KEY,
      ...(options.headers || {}),
    },
  });
  const data = await res.json();
  return { ok: res.ok, status: res.status, data };
}

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

// ---- Find account ----
document.getElementById('btn-lookup').addEventListener('click', async () => {
  const code = document.getElementById('lookup-code').value.trim();
  const resultBox = document.getElementById('account-result');
  resultBox.innerHTML = '';
  if (!code) return;

  const found = await api(`/accounts/by-code/${encodeURIComponent(code)}`);
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
  container.innerHTML = `
    <div class="acct-card">
      <div class="name">${acct.name}</div>
      <div class="meta">${acct.card_code} · ${acct.type} ${acct.rank ? '· ' + acct.rank : ''}</div>
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

// ---- New account ----
document.getElementById('btn-new-account').addEventListener('click', async () => {
  const body = {
    cardCode: document.getElementById('na-code').value.trim(),
    type: document.getElementById('na-type').value,
    name: document.getElementById('na-name').value.trim(),
    phone: document.getElementById('na-phone').value.trim(),
    rank: document.getElementById('na-rank').value,
  };
  const result = await api('/accounts', { method: 'POST', body: JSON.stringify(body) });
  const box = document.getElementById('new-account-result');
  box.className = 'result-msg ' + (result.ok ? 'ok' : 'err');
  box.textContent = result.ok ? `Account created: ${result.data.card_code} (${result.data.type})` : result.data.error;
});

// ---- Fuel & earn ----
document.getElementById('btn-fuel').addEventListener('click', async () => {
  const code = document.getElementById('fuel-code').value.trim();
  const account = await api(`/accounts/by-code/${encodeURIComponent(code)}`);
  const box = document.getElementById('fuel-result');
  if (!account.ok) { box.className = 'result-msg err'; box.textContent = account.data.error; return; }

  const body = {
    accountId: account.data.id,
    litres: document.getElementById('fuel-litres').value,
    fuelType: document.getElementById('fuel-type').value,
    station: document.getElementById('fuel-station').value.trim(),
    amountKsh: document.getElementById('fuel-amount').value,
  };
  const result = await api('/fuel', { method: 'POST', body: JSON.stringify(body) });
  box.className = 'result-msg ' + (result.ok ? 'ok' : 'err');
  box.textContent = result.ok
    ? `+${Math.round(result.data.pointsEarned)} points at ${result.data.ratePerLitre} pts/L${result.data.tierLabel ? ' (tier: ' + result.data.tierLabel + ')' : ''}. New balance: ${Math.round(result.data.newBalance)}.`
    : result.data.error;
});

// ---- Redeem ----
document.getElementById('btn-redeem').addEventListener('click', async () => {
  const code = document.getElementById('redeem-code').value.trim();
  const account = await api(`/accounts/by-code/${encodeURIComponent(code)}`);
  const box = document.getElementById('redeem-result');
  if (!account.ok) { box.className = 'result-msg err'; box.textContent = account.data.error; return; }

  const body = {
    accountId: account.data.id,
    invoiceAmount: document.getElementById('redeem-invoice').value,
    pointsRequested: document.getElementById('redeem-points').value,
  };
  const result = await api('/redeem', { method: 'POST', body: JSON.stringify(body) });
  box.className = 'result-msg ' + (result.data.status === 'approved' ? 'ok' : 'err');
  box.textContent = result.data.status === 'approved'
    ? `Applied. New invoice: KSh ${Math.round(result.data.newInvoiceTotal).toLocaleString()}. Balance: ${Math.round(result.data.newBalance)} points.`
    : result.data.rejectionReason;
});

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
