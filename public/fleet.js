// public/fleet.js
// Fleet manager dashboard — a completely separate login/session from the
// staff console (public/app.js uses hn_token/hn_staff; this uses
// hn_fleet_token/hn_fleet_account, its own storage keys, on purpose).
//
// This file never sends an accountId anywhere — every request just asks
// "give me my stuff", and the server decides whose stuff that is from the
// session token alone (services/fleetAuthService.js). That's what makes
// cross-account access impossible, not anything checked here.

function getFleetToken() { return localStorage.getItem('hn_fleet_token'); }
function getFleetAccount() {
  try { return JSON.parse(localStorage.getItem('hn_fleet_account') || 'null'); } catch { return null; }
}
function clearFleetSession() {
  localStorage.removeItem('hn_fleet_token');
  localStorage.removeItem('hn_fleet_account');
}

async function fleetApi(path, options = {}) {
  const res = await fetch(`/api/fleet${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${getFleetToken() || ''}`,
      ...(options.headers || {}),
    },
  });
  if (res.status === 401) {
    clearFleetSession();
    location.href = 'fleet-login.html';
    return { ok: false, status: 401, data: { error: 'Login required' } };
  }
  const data = await res.json();
  return { ok: res.ok, status: res.status, data };
}

const fleetAccount = getFleetAccount();
const fleetNameEl = document.getElementById('fleet-account-name');
if (fleetNameEl && fleetAccount) {
  fleetNameEl.textContent = `${fleetAccount.name} · ${fleetAccount.card_code}`;
}
document.getElementById('btn-fleet-logout').addEventListener('click', async () => {
  await fleetApi('/auth/logout', { method: 'POST' });
  clearFleetSession();
  location.href = 'fleet-login.html';
});

async function loadOverview() {
  const result = await fleetApi('/dashboard');
  if (!result.ok) return;
  document.getElementById('ov-balance').textContent = Math.round(result.data.balance).toLocaleString();
  document.getElementById('ov-rate').textContent = result.data.tier.currentRate;
  document.getElementById('ov-litres').textContent = Math.round(result.data.tier.trailingLitres).toLocaleString();
}

async function loadVehicles() {
  const result = await fleetApi('/vehicles');
  const listBox = document.getElementById('vehicle-list');
  if (!result.ok) { listBox.innerHTML = `<div class="result-msg err">Could not load vehicles</div>`; return; }

  if (!result.data.length) {
    listBox.innerHTML = `<p class="screen-sub">No vehicles added yet.</p>`;
    return;
  }

  listBox.innerHTML = `<table>
    <thead><tr><th>Registration</th><th>Type</th><th>Driver</th><th>Status</th><th></th></tr></thead>
    <tbody>${result.data.map(v => `
      <tr>
        <td>${v.registration_number}</td>
        <td>${v.vehicle_type || '—'}</td>
        <td>${v.driver_name || '—'}${v.driver_phone ? ' (' + v.driver_phone + ')' : ''}</td>
        <td>${v.active ? 'Active' : 'Inactive'}</td>
        <td>
          <button class="btn-logout" data-history="${v.id}">History</button>
          ${v.active ? `<button class="btn-logout" data-deactivate="${v.id}">Deactivate</button>` : ''}
        </td>
      </tr>`).join('')}</tbody>
  </table>`;

  listBox.querySelectorAll('[data-deactivate]').forEach(btn => {
    btn.addEventListener('click', async () => {
      await fleetApi(`/vehicles/${btn.dataset.deactivate}/deactivate`, { method: 'POST' });
      loadVehicles();
    });
  });
  listBox.querySelectorAll('[data-history]').forEach(btn => {
    btn.addEventListener('click', () => loadVehicleHistory(btn.dataset.history, btn.closest('tr').children[0].textContent));
  });
}

async function loadVehicleHistory(vehicleId, registration) {
  const historyBox = document.getElementById('vehicle-history');
  const result = await fleetApi(`/vehicles/${vehicleId}/transactions`);
  if (!result.ok) {
    historyBox.innerHTML = `<div class="result-msg err">${result.data.error || 'Could not load history'}</div>`;
    return;
  }
  const rows = result.data;
  const body = rows.length
    ? rows.map(r => `<tr><td>${new Date(r.created_at).toLocaleDateString()}</td><td>${r.litres} L</td><td>${r.fuel_type}</td><td style="color:var(--good)">+${Math.round(r.points_earned)}</td></tr>`).join('')
    : `<tr><td colspan="4">No fuel history for this vehicle yet.</td></tr>`;
  historyBox.innerHTML = `
    <h2 class="screen-title" style="font-size:18px;margin-top:24px;">History — ${registration}</h2>
    <table>
      <thead><tr><th>Date</th><th>Litres</th><th>Fuel</th><th>Points</th></tr></thead>
      <tbody>${body}</tbody>
    </table>`;
}

document.getElementById('btn-add-vehicle').addEventListener('click', async () => {
  const box = document.getElementById('add-vehicle-result');
  const body = {
    registrationNumber: document.getElementById('veh-reg').value.trim(),
    vehicleType: document.getElementById('veh-type').value,
    driverName: document.getElementById('veh-driver-name').value.trim(),
    driverPhone: document.getElementById('veh-driver-phone').value.trim(),
  };
  if (!body.registrationNumber) {
    box.className = 'result-msg err';
    box.textContent = 'Registration number is required';
    return;
  }

  const result = await fleetApi('/vehicles', { method: 'POST', body: JSON.stringify(body) });
  box.className = 'result-msg ' + (result.ok ? 'ok' : 'err');
  box.textContent = result.ok ? `Vehicle ${result.data.registration_number} added.` : result.data.error;
  if (result.ok) {
    document.getElementById('veh-reg').value = '';
    document.getElementById('veh-driver-name').value = '';
    document.getElementById('veh-driver-phone').value = '';
    loadVehicles();
  }
});

loadOverview();
loadVehicles();
