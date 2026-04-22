/* ============================================================
   Endurance Race Planner — frontend app.js
   ============================================================ */

'use strict';

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
const state = {
  activePlan:   null,   // full plan object from API
  activeTab:    'setup',
  fuelMode:     'normal',
  liveInterval: null,
};

const COLORS = ['#4fc3f7','#81c784','#ffb74d','#f06292','#ce93d8','#80deea','#ffcc02','#ff8a65'];
const MODE_MULT = { save: 0.92, normal: 1.0, push: 1.08 };

const TIRE_LABELS = { S: 'Soft', M: 'Med', H: 'Hard', I: 'Inter', W: 'Wet' };
const TIRE_OPTS = Object.entries(TIRE_LABELS)
  .map(([v, l]) => `<option value="${v}">${l}</option>`).join('');

// Car presets: tank capacity (L) and typical fuel per lap (L) as a starting point.
// fpl values are approximate mid-range track estimates — always verify for your circuit.
const CAR_PRESETS = {
  gtp_porsche:   { tank: 19.8, fpl: 0.92 },
  gtp_bmw:       { tank: 19.8, fpl: 0.90 },
  gtp_cadillac:  { tank: 19.8, fpl: 0.92 },
  gtp_acura:     { tank: 19.8, fpl: 0.90 },
  lmp2:          { tank: 19.8, fpl: 0.79 },
  lmp3:          { tank: 14.5, fpl: 0.63 },
  gte_ferrari:   { tank: 23.8, fpl: 1.03 },
  gte_porsche:   { tank: 23.8, fpl: 1.00 },
  gt3_bmw:       { tank: 26.4, fpl: 1.08 },
  gt3_ferrari:   { tank: 26.4, fpl: 1.03 },
  gt3_porsche:   { tank: 26.4, fpl: 1.00 },
  gt3_lambo:     { tank: 26.4, fpl: 1.06 },
  gt3_mclaren:   { tank: 26.4, fpl: 1.03 },
  gt3_mercedes:  { tank: 26.4, fpl: 1.06 },
  gt4:           { tank: 17.2, fpl: 0.74 },
  mx5:           { tank: 11.9, fpl: 0.50 },
  ir18:          { tank: 18.5, fpl: 0.66 },
};

// ---------------------------------------------------------------------------
// DOM helpers
// ---------------------------------------------------------------------------
const $  = (sel, ctx = document) => ctx.querySelector(sel);
const $$ = (sel, ctx = document) => [...ctx.querySelectorAll(sel)];

function showMessage(container, text, type = 'success') {
  container.innerHTML = `<span class="msg-${type}">${text}</span>`;
  setTimeout(() => { container.innerHTML = ''; }, 4000);
}

function fmt(n, decimals = 1) {
  return Number(n).toFixed(decimals);
}

function secToMinSec(s) {
  const m = Math.floor(s / 60);
  const sec = (s % 60).toFixed(1).padStart(4, '0');
  return `${m}:${sec}`;
}

function secToMinSecFull(s) {
  const m   = Math.floor(s / 60);
  const sec = (s % 60).toFixed(3).padStart(6, '0');
  return `${m}:${sec}`;
}

function hrsToHM(hrs) {
  const h = Math.floor(hrs);
  const m = Math.round((hrs - h) * 60);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

// ---------------------------------------------------------------------------
// Tabs
// ---------------------------------------------------------------------------
function initTabs() {
  $$('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const tab = btn.dataset.tab;
      $$('.tab-btn').forEach(b => b.classList.remove('active'));
      $$('.tab-section').forEach(s => s.classList.remove('active'));
      btn.classList.add('active');
      $(`#tab-${tab}`).classList.add('active');
      state.activeTab = tab;
      if (tab === 'stint'    && state.activePlan) renderStintTable(state.activePlan);
      if (tab === 'live'     && state.activePlan) { renderLiveMode(state.activePlan); loadCompetitors(); }
      if (tab === 'laps'     && state.activePlan) renderLapTimes(state.activePlan);
      if (tab === 'debrief'  && state.activePlan) renderDebrief(state.activePlan);
      if (tab === 'export'   && state.activePlan) renderExport(state.activePlan);
      if (tab === 'timeline' && state.activePlan) renderTimeline(state.activePlan);
    });
  });
}

// ---------------------------------------------------------------------------
// Plan selector (header dropdown)
// ---------------------------------------------------------------------------
async function loadPlanList() {
  try {
    const res   = await fetch('/api/plans');
    if (!res.ok) return;
    const plans = await res.json();
    const sel   = $('#planSelect');

    // keep existing "new plan" option, rebuild the rest
    while (sel.options.length > 1) sel.remove(1);

    plans.forEach(p => {
      const opt = new Option(p.name, p.id);
      sel.add(opt);
    });

    if (state.activePlan) {
      sel.value = state.activePlan.id;
    }
  } catch (_) { /* server unreachable — silently skip */ }
}

async function loadPlan(id) {
  try {
    const res  = await fetch(`/api/plans/${id}`);
    if (!res.ok) return;
    const plan = await res.json();
    state.activePlan = plan;
    populateSetupForm(plan);
    renderStintTable(plan);
    renderLiveMode(plan);
    renderLapTimes(plan);
    renderExport(plan);
    $('#planSelect').value = id;
    // Show plan ID badge in header and on live tab
    const badge = `<span class="plan-id-badge" title="Use this ID in the Telemetry Bridge">ID: ${plan.id}</span>`;
    document.querySelectorAll('.plan-id-display').forEach(el => el.innerHTML = badge);
    // Update pit wall link with plan ID
    const pwLink = $('#pitWallLinkBtn');
    if (pwLink) pwLink.href = `/pitwall/${plan.id}`;
    // Start telemetry polling
    startTelemetryPolling();
  } catch (_) { /* server unreachable */ }
}

// ---------------------------------------------------------------------------
// Setup form helpers
// ---------------------------------------------------------------------------
function getLapTimeSec() {
  const m = parseFloat($('#lapTimeMin').value) || 0;
  const s = parseFloat($('#lapTimeSec').value) || 0;
  return m * 60 + s;
}

function populateSetupForm(plan) {
  const c = plan.config;
  $('#planName').value      = plan.name || '';
  $('#raceDuration').value  = c.race_duration_hrs || 6;
  const lapSec = c.lap_time_s || 105;
  $('#lapTimeMin').value    = Math.floor(lapSec / 60);
  $('#lapTimeSec').value    = (lapSec % 60).toFixed(1);
  $('#pitLoss').value       = c.pit_loss_s || 35;
  $('#maxContinuousHrs').value = c.max_continuous_hrs || 2.5;
  $('#fuelCapacity').value  = c.fuel_capacity_l || 18;
  $('#fuelPerLap').value    = c.fuel_per_lap_l || 0.92;
  $('#tireWearRate').value  = c.tire_wear_rate_pct ?? 0;

  state.fuelMode = c.fuel_mode || 'normal';
  $$('.mode-btn').forEach(b => b.classList.toggle('active', b.dataset.mode === state.fuelMode));

  // drivers
  $('#driverList').innerHTML = '';
  (plan.drivers || []).forEach(d => addDriverRow(d));

  updateFuelPreview();
}

function buildConfig() {
  return {
    race_duration_hrs:  parseFloat($('#raceDuration').value)  || 6,
    lap_time_s:         getLapTimeSec(),
    pit_loss_s:         parseFloat($('#pitLoss').value)       || 35,
    max_continuous_hrs: parseFloat($('#maxContinuousHrs').value) || 2.5,
    fuel_capacity_l:    parseFloat($('#fuelCapacity').value)  || 18,
    fuel_per_lap_l:     parseFloat($('#fuelPerLap').value)    || 0.92,
    fuel_mode:          state.fuelMode,
    tire_wear_rate_pct: parseFloat($('#tireWearRate').value) || 0,
  };
}

function buildDrivers() {
  return $$('.driver-row').map((row, i) => {
    const tMin = parseFloat($('.driver-target-min', row).value);
    const tSec = parseFloat($('.driver-target-sec', row).value);
    const targetLapS = (!isNaN(tMin) || !isNaN(tSec))
      ? (isNaN(tMin) ? 0 : tMin) * 60 + (isNaN(tSec) ? 0 : tSec)
      : null;
    const rawFpl = parseFloat($('.driver-target-fpl', row).value);
    return {
      name:         $('.driver-name', row).value.trim() || `Driver ${i + 1}`,
      max_hours:    parseFloat($('.driver-maxhrs', row).value) || 2.5,
      min_hours:    parseFloat($('.driver-minhrs', row).value) || 0,
      color:        $('.driver-color', row).value,
      target_lap_s: (targetLapS && targetLapS > 0) ? targetLapS : null,
      target_fpl:   (!isNaN(rawFpl) && rawFpl > 0) ? rawFpl : null,
    };
  });
}

// ---------------------------------------------------------------------------
// Tire data helpers
// ---------------------------------------------------------------------------
async function saveTireData(planId, stintId, data) {
  await fetch(`/api/plans/${planId}/stints/${stintId}`, {
    method:  'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify(data),
  });
}

function tireBadgeHtml(compound, set) {
  if (!compound) return '';
  const cls  = `tire-badge tire-badge-${compound.toLowerCase()}`;
  const label = set ? `${compound} <span class="tire-set-lbl">${set}</span>` : compound;
  return `<span class="${cls}">${label}</span>`;
}

function tireSelectHtml(stintId, current) {
  const opts = `<option value="">—</option>${TIRE_OPTS}`;
  const sel  = `<select class="tire-cmp" data-stint-id="${stintId}">${opts}</select>`;
  // We set value via JS after insertion; return the markup with current baked in
  return sel.replace(`value="${current}"`, `value="${current}" selected`);
}

// ---------------------------------------------------------------------------
// Driver rows
// ---------------------------------------------------------------------------
function addDriverRow(driver = null) {
  const tmpl = $('#driverRowTemplate').content.cloneNode(true);
  const row  = tmpl.querySelector('.driver-row');
  const idx  = $$('.driver-row').length;

  if (driver) {
    $('.driver-color',  row).value = driver.color     || COLORS[idx % COLORS.length];
    $('.driver-name',   row).value = driver.name      || '';
    $('.driver-maxhrs', row).value = driver.max_hours || 2.5;
    $('.driver-minhrs', row).value = driver.min_hours || 0;
    if (driver.target_lap_s && driver.target_lap_s > 0) {
      $('.driver-target-min', row).value = Math.floor(driver.target_lap_s / 60);
      $('.driver-target-sec', row).value = (driver.target_lap_s % 60).toFixed(1);
    }
    if (driver.target_fpl && driver.target_fpl > 0) {
      $('.driver-target-fpl', row).value = driver.target_fpl;
    }
  } else {
    $('.driver-color', row).value = COLORS[idx % COLORS.length];
  }

  $('.remove-driver', row).addEventListener('click', () => {
    row.remove();
    updateFuelPreview();
  });

  $('#driverList').appendChild(row);
  updateFuelPreview();
}

// ---------------------------------------------------------------------------
// Live fuel preview (client-side math, mirrors server)
// ---------------------------------------------------------------------------
function updateFuelPreview() {
  const cap    = parseFloat($('#fuelCapacity').value) || 18;
  const fpl    = parseFloat($('#fuelPerLap').value)   || 0.92;
  const mult   = MODE_MULT[state.fuelMode] || 1;
  const effFpl = fpl * mult;
  const usable = cap - effFpl;                        // 1-lap safety buffer
  const laps   = Math.floor(usable / effFpl);
  const lapSec = getLapTimeSec() || 90;
  const stintSec = laps * lapSec;

  $('#previewLaps').textContent       = laps > 0 ? laps : '—';
  $('#previewStintTime').textContent  = laps > 0 ? hrsToHM(stintSec / 3600) : '—';
  $('#previewFpl').textContent        = `${fmt(effFpl, 3)} gal`;
}

// ---------------------------------------------------------------------------
// Calculate / Save
// ---------------------------------------------------------------------------
async function calculateStrategy() {
  const config  = buildConfig();
  const drivers = buildDrivers();
  const name    = $('#planName').value.trim() || 'Untitled Plan';
  const msg     = $('#setupMessages');

  try {
    let res, plan;
    if (state.activePlan) {
      res  = await fetch(`/api/plans/${state.activePlan.id}`, {
        method:  'PUT',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ name, config, drivers }),
      });
      if (!res.ok) {
        showMessage(msg, `Server error ${res.status} — could not update plan.`, 'error');
        return;
      }
      plan = await res.json();
    } else {
      res  = await fetch('/api/plans', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ name, config, drivers }),
      });
      if (!res.ok) {
        showMessage(msg, `Server error ${res.status} — could not create plan.`, 'error');
        return;
      }
      const data = await res.json();
      // after create, fetch full plan
      const res2 = await fetch(`/api/plans/${data.id}`);
      if (!res2.ok) {
        showMessage(msg, 'Plan created but could not reload — please refresh.', 'error');
        return;
      }
      plan = await res2.json();
    }

    state.activePlan = plan;
    await loadPlanList();
    showMessage(msg, 'Strategy calculated!');
    renderStintTable(plan);

    // auto-switch to stint tab
    $$('.tab-btn').forEach(b => b.classList.remove('active'));
    $$('.tab-section').forEach(s => s.classList.remove('active'));
    $('[data-tab="stint"]').classList.add('active');
    $('#tab-stint').classList.add('active');
  } catch (err) {
    showMessage(msg, `Error: ${err.message || 'Could not reach server'}`, 'error');
  }
}

async function saveSetup() {
  if (!state.activePlan) {
    await calculateStrategy();
    return;
  }
  const config  = buildConfig();
  const drivers = buildDrivers();
  const name    = $('#planName').value.trim() || state.activePlan.name;
  const msg     = $('#setupMessages');

  try {
    const res = await fetch(`/api/plans/${state.activePlan.id}`, {
      method:  'PUT',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ name, config, drivers }),
    });
    if (res.ok) {
      const plan = await res.json();
      state.activePlan = plan;
      await loadPlanList();
      showMessage(msg, 'Plan saved.');
    } else {
      showMessage(msg, `Save failed (${res.status}).`, 'error');
    }
  } catch (err) {
    showMessage(msg, `Error: ${err.message || 'Could not reach server'}`, 'error');
  }
}

// ---------------------------------------------------------------------------
// Stint Table
// ---------------------------------------------------------------------------
function renderStintTable(plan) {
  const wrap   = $('#stintTableWrap');
  const stints = plan.stints || [];

  if (!stints.length) {
    wrap.innerHTML = '<p class="empty-state">No stints calculated yet. Use the Setup tab.</p>';
    return;
  }

  const config       = plan.config || {};
  const fuelCap      = config.fuel_capacity_l || 18;
  const globalLapSec = config.lap_time_s || 90;
  const globalFpl    = config.fuel_per_lap_l * (MODE_MULT[config.fuel_mode] || 1);
  const totalLaps    = stints[stints.length - 1]?.end_lap || 1;
  const wearRate     = config.tire_wear_rate_pct || 0;
  const driversMap   = {};
  (plan.drivers || []).forEach(d => { driversMap[d.id] = d; });

  // meta badges — use global values for summary
  const lapsPerTank = Math.floor((fuelCap - globalFpl) / globalFpl);
  const pitStops    = stints.filter(s => s.pit_lap).length;

  $('#strategyMeta').innerHTML = `
    <span class="badge">Total laps: <strong>${totalLaps}</strong></span>
    <span class="badge">Stints: <strong>${stints.length}</strong></span>
    <span class="badge">Pit stops: <strong>${pitStops}</strong></span>
    <span class="badge">Laps/tank (global): <strong>${lapsPerTank}</strong></span>
    <span class="badge">Fuel mode: <strong>${config.fuel_mode || 'normal'}</strong></span>
  `;

  let html = `
    <div class="stint-table-wrap">
    <table class="stint-table">
      <thead>
        <tr>
          <th>#</th>
          <th>Driver</th>
          <th>Tires</th>
          <th>Est. Wear</th>
          <th>Start Lap</th>
          <th>End Lap</th>
          <th>Laps</th>
          <th>Stint Time</th>
          <th>Pit Lap</th>
          <th>Fuel Load</th>
          <th>Actual Fuel</th>
          <th>Fuel/Lap</th>
          <th>Fuel %</th>
          <th title="Swap this driver with adjacent stint">⇅</th>
        </tr>
      </thead>
      <tbody>
  `;

  stints.forEach(s => {
    const laps      = s.end_lap - s.start_lap + 1;
    // Use per-driver target lap time if set, else global
    const driver    = driversMap[s.driver_id];
    const lapSec    = (driver && driver.target_lap_s > 0) ? driver.target_lap_s : globalLapSec;
    const dFpl      = (driver && driver.target_fpl > 0)
                        ? driver.target_fpl * (MODE_MULT[config.fuel_mode] || 1)
                        : globalFpl;
    const stintSec  = laps * lapSec;
    const fuelPct   = Math.min(Math.round((s.fuel_load / fuelCap) * 100), 100);
    const isLast    = !s.pit_lap;
    const dotColor  = s.driver_color || '#4fc3f7';
    const pitCell   = isLast
      ? '<span class="no-pit-badge">FINISH</span>'
      : `<span class="pit-badge">Lap ${s.pit_lap}</span>`;

    const cmpSel  = tireSelectHtml(s.id, s.tire_compound || '');
    const ageVal  = s.tire_age_laps != null ? s.tire_age_laps : '';
    const setVal  = s.tire_set || '';

    // Estimated wear: (starting age + laps this stint) × rate, capped at 100
    const startAge   = s.tire_age_laps != null ? s.tire_age_laps : 0;
    const estWear    = wearRate > 0 ? Math.min(Math.round((startAge + laps) * wearRate), 100) : null;
    const wearColor  = estWear == null ? '' : estWear >= 80 ? 'var(--red)' : estWear >= 55 ? 'var(--yellow)' : 'var(--green)';
    const actualWear = s.tire_wear_pct != null ? `<span class="actual-wear-tag">${fmt(s.tire_wear_pct, 0)}% actual</span>` : '';
    const wearCell   = estWear != null
      ? `<span style="color:${wearColor};font-weight:600">${estWear}%</span> <span class="wear-label">est</span>${actualWear}`
      : (s.tire_wear_pct != null ? `${fmt(s.tire_wear_pct, 0)}%` : '<span style="color:var(--text-muted)">—</span>');

    const driverOpts = (plan.drivers || []).map(d =>
      `<option value="${d.id}" ${d.id === s.driver_id ? 'selected' : ''}>${d.name}</option>`
    ).join('');

    const hasDriverLap = driver && driver.target_lap_s > 0;
    const hasDriverFpl = driver && driver.target_fpl > 0;

    html += `
      <tr class="${isLast ? 'last-stint' : ''}">
        <td>${s.stint_num}</td>
        <td class="driver-cell">
          <span class="driver-dot" style="background:${dotColor}" data-stint-id="${s.id}"></span>
          <select class="driver-sel" data-stint-id="${s.id}">
            ${driverOpts}
          </select>
        </td>
        <td class="tire-cell">
          <div class="tire-inputs">
            ${cmpSel}
            <input type="text"   class="tire-set-inp" data-stint-id="${s.id}" value="${setVal}"  placeholder="Set#" maxlength="6" title="Set number" />
            <input type="number" class="tire-age-inp" data-stint-id="${s.id}" value="${ageVal}" placeholder="Age"  min="0" max="999" title="Laps already on tires" />
          </div>
        </td>
        <td class="wear-cell">${wearCell}</td>
        <td>${s.start_lap}</td>
        <td>${s.end_lap}</td>
        <td>${laps}</td>
        <td${hasDriverLap ? ' title="Based on driver\'s target lap time"' : ''}>
          ${hrsToHM(stintSec / 3600)}${hasDriverLap ? ' <span class="driver-target-tag">★</span>' : ''}
        </td>
        <td>${pitCell}</td>
        <td>${fmt(s.fuel_load, 1)} gal</td>
        <td class="actual-fuel-cell">
          ${s.actual_fuel_added != null
            ? (() => {
                const delta = s.actual_fuel_added - s.fuel_load;
                const cls   = Math.abs(delta) < 0.5 ? 'delta-ok' : delta > 0 ? 'delta-over' : 'delta-under';
                return `<span class="actual-fuel-val">${fmt(s.actual_fuel_added, 1)} gal</span>
                        <span class="actual-fuel-delta ${cls}">${delta >= 0 ? '+' : ''}${fmt(delta, 1)}</span>`;
              })()
            : `<input type="number" class="actual-fuel-inp" data-stint-id="${s.id}"
                 value="" placeholder="actual" step="0.1" min="0"
                 title="Actual fuel added at this pit stop" />`
          }
        </td>
        <td${hasDriverFpl ? ' title="Driver\'s own fuel rate"' : ''}>
          <span${hasDriverFpl ? ' class="driver-target-tag"' : ''} style="font-variant-numeric:tabular-nums">${fmt(dFpl, 3)}</span>
        </td>
        <td class="fuel-bar-cell">
          <div class="fuel-bar">
            <div class="fuel-bar-fill" style="width:${fuelPct}%"></div>
          </div>
          <span style="font-size:0.7rem;color:var(--text-dim)">${fuelPct}%</span>
        </td>
        <td class="swap-cell">
          ${s.stint_num > 1
            ? `<button class="swap-btn" data-stint="${s.stint_num}" data-dir="up" title="Swap driver with stint above">↑</button>`
            : ''}
          ${!isLast
            ? `<button class="swap-btn" data-stint="${s.stint_num}" data-dir="down" title="Swap driver with stint below">↓</button>`
            : ''}
        </td>
      </tr>
    `;
  });

  html += '</tbody></table></div>';
  wrap.innerHTML = html;

  // Auto-save tire data when any tire field changes
  $$('.tire-cmp, .tire-set-inp, .tire-age-inp', wrap).forEach(el => {
    el.addEventListener('change', () => {
      const sid    = el.dataset.stintId;
      const cmp    = wrap.querySelector(`.tire-cmp[data-stint-id="${sid}"]`)?.value || null;
      const set    = wrap.querySelector(`.tire-set-inp[data-stint-id="${sid}"]`)?.value.trim() || null;
      const ageEl  = wrap.querySelector(`.tire-age-inp[data-stint-id="${sid}"]`);
      const age    = ageEl && ageEl.value !== '' ? parseInt(ageEl.value) : null;
      saveTireData(plan.id, sid, {
        tire_compound:  cmp || null,
        tire_set:       set || null,
        tire_age_laps:  age,
      });
    });
  });

  // Actual fuel added — save when user enters a value and blurs/presses Enter
  $$('.actual-fuel-inp', wrap).forEach(inp => {
    const save = async () => {
      const val = parseFloat(inp.value);
      if (isNaN(val) || val < 0) return;
      const sid = inp.dataset.stintId;
      await fetch(`/api/plans/${plan.id}/stints/${sid}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ actual_fuel_added: val }),
      });
      // Reload plan to show delta
      const r = await fetch(`/api/plans/${plan.id}`);
      const updated = await r.json();
      state.activePlan = updated;
      renderStintTable(updated);
    };
    inp.addEventListener('blur', save);
    inp.addEventListener('keydown', e => { if (e.key === 'Enter') save(); });
  });

  // Stint swap — exchange the drivers of two adjacent stints
  $$('.swap-btn', wrap).forEach(btn => {
    btn.addEventListener('click', async () => {
      const stintNum  = parseInt(btn.dataset.stint);
      const dir       = btn.dataset.dir;
      const otherNum  = dir === 'up' ? stintNum - 1 : stintNum + 1;
      const stintA    = stints.find(s => s.stint_num === stintNum);
      const stintB    = stints.find(s => s.stint_num === otherNum);
      if (!stintA || !stintB) return;

      // Swap driver IDs between the two stints
      await fetch(`/api/plans/${plan.id}/stints/${stintA.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ driver_id: stintB.driver_id }),
      });
      await fetch(`/api/plans/${plan.id}/stints/${stintB.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ driver_id: stintA.driver_id }),
      });

      const r = await fetch(`/api/plans/${plan.id}`);
      const updated = await r.json();
      state.activePlan = updated;
      renderStintTable(updated);
    });
  });

  // Driver assignment — change dropdown to reassign a stint to any driver
  $$('.driver-sel', wrap).forEach(sel => {
    sel.addEventListener('change', async () => {
      const sid      = parseInt(sel.dataset.stintId);
      const driverId = parseInt(sel.value);
      const driver   = (plan.drivers || []).find(d => d.id === driverId);

      // Optimistic update: swap dot color immediately
      const dot = wrap.querySelector(`.driver-dot[data-stint-id="${sid}"]`);
      if (dot && driver) dot.style.background = driver.color;

      await fetch(`/api/plans/${plan.id}/stints/${sid}`, {
        method:  'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ driver_id: driverId }),
      });

      // Update local state so timeline re-render is accurate
      const stint = (state.activePlan?.stints || []).find(s => s.id === sid);
      if (stint && driver) {
        stint.driver_id    = driverId;
        stint.driver_name  = driver.name;
        stint.driver_color = driver.color;
      }

      renderTimeline(state.activePlan);
    });
  });

  // Driver minimum time warnings
  const driverHours = {};
  (plan.drivers || []).forEach(d => { driverHours[d.id] = 0; });
  stints.forEach(s => {
    if (s.driver_id != null) {
      const laps = s.end_lap - s.start_lap + 1;
      const d    = driversMap[s.driver_id];
      const lapS = (d && d.target_lap_s > 0) ? d.target_lap_s : globalLapSec;
      driverHours[s.driver_id] = (driverHours[s.driver_id] || 0) + (laps * lapS / 3600);
    }
  });
  const minWarnings = (plan.drivers || []).filter(d =>
    d.min_hours > 0 && (driverHours[d.id] || 0) < d.min_hours
  );
  const minWarnEl = document.getElementById('minTimeWarnings');
  if (minWarnEl) {
    if (minWarnings.length) {
      minWarnEl.innerHTML = minWarnings.map(d => {
        const actual = (driverHours[d.id] || 0);
        const deficit = (d.min_hours - actual).toFixed(2);
        return `<span class="min-time-warn">
          <span class="driver-dot" style="background:${d.color}"></span>
          <strong>${d.name}</strong> is <strong>${deficit}h short</strong> of minimum
          (${actual.toFixed(2)}h planned / ${d.min_hours}h required)
        </span>`;
      }).join('');
      minWarnEl.style.display = 'flex';
    } else {
      minWarnEl.innerHTML = '';
      minWarnEl.style.display = 'none';
    }
  }

  renderTimeline(plan);
}

// ---------------------------------------------------------------------------
// Timeline
// ---------------------------------------------------------------------------
function renderTimeline(plan) {
  const stints  = plan.stints || [];
  const drivers = plan.drivers || [];
  const wrap    = $('#timelineWrap');
  const el      = $('#timeline');

  if (!stints.length) { wrap.style.display = 'none'; return; }
  wrap.style.display = 'block';

  const totalLaps = stints[stints.length - 1]?.end_lap || 1;

  // group stints by driver
  const byDriver = {};
  drivers.forEach(d => { byDriver[d.name] = []; });
  stints.forEach(s => {
    const key = s.driver_name || 'Unknown';
    if (!byDriver[key]) byDriver[key] = [];
    byDriver[key].push(s);
  });

  el.innerHTML = '';
  Object.entries(byDriver).forEach(([driverName, dStints]) => {
    if (!dStints.length) return;
    const color = dStints[0].driver_color || '#4fc3f7';

    const row   = document.createElement('div');
    row.className = 'timeline-driver-row';

    const lbl   = document.createElement('div');
    lbl.className = 'timeline-label';
    lbl.textContent = driverName;

    const track = document.createElement('div');
    track.className = 'timeline-track';

    dStints.forEach(s => {
      const left  = ((s.start_lap - 1) / totalLaps) * 100;
      const width = ((s.end_lap - s.start_lap + 1) / totalLaps) * 100;

      const seg = document.createElement('div');
      seg.className = 'timeline-seg';
      seg.style.left       = `${left}%`;
      seg.style.width      = `${Math.max(width - 0.3, 0.3)}%`;
      seg.style.background = color;
      seg.title            = `Stint ${s.stint_num}: Laps ${s.start_lap}–${s.end_lap}`;
      seg.textContent      = s.stint_num;
      track.appendChild(seg);
    });

    row.appendChild(lbl);
    row.appendChild(track);
    el.appendChild(row);
  });
}

// ---------------------------------------------------------------------------
// Live Mode
// ---------------------------------------------------------------------------
function renderLiveMode(plan) {
  const stints = plan.stints || [];

  // populate live stint list
  const listEl = $('#liveStintList');
  if (!stints.length) {
    listEl.innerHTML = '<p class="empty-state">No stints loaded.</p>';
    return;
  }

  listEl.innerHTML = '';
  stints.forEach((s, idx) => {
    const item = document.createElement('div');
    item.className = 'live-stint-item' + (s.is_complete ? ' is-complete' : '');
    item.dataset.stintId  = s.id;
    item.dataset.startLap = s.start_lap;
    item.dataset.endLap   = s.end_lap;

    const color    = s.driver_color || '#4fc3f7';
    const tireBadge = tireBadgeHtml(s.tire_compound, s.tire_set);
    item.innerHTML = `
      <span class="stint-num">#${s.stint_num}</span>
      <span class="driver-dot" style="background:${color}"></span>
      <span class="stint-driver">${s.driver_name || '—'}</span>
      ${tireBadge}
      <span class="stint-laps">${s.start_lap}–${s.end_lap}</span>
      ${!s.is_complete ? `<button class="complete-btn" data-id="${s.id}" data-idx="${idx}">✓ Done</button>` : '<span style="font-size:0.7rem;color:var(--green)">Done</span>'}
    `;
    listEl.appendChild(item);
  });

  // complete buttons
  $$('.complete-btn').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const stintId   = parseInt(btn.dataset.id);
      const stintIdx  = parseInt(btn.dataset.idx);
      const nextStint = stints[stintIdx + 1] || null;

      if (nextStint && !nextStint.is_complete) {
        showTirePrompt(btn, plan.id, stintId, nextStint);
      } else {
        await completStintNow(plan.id, stintId);
      }
    });
  });

  // render event log
  renderEventLog(plan.events || []);

  // update live status for current lap
  updateLiveStatus();
}

async function completStintNow(planId, stintId) {
  const curLap = parseInt($('#currentLap').value) || 1;
  await fetch(`/api/plans/${planId}/stints/${stintId}/complete`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ actual_end_lap: curLap }),
  });
  const updated = await (await fetch(`/api/plans/${planId}`)).json();
  state.activePlan = updated;
  renderLiveMode(updated);
}

function showTirePrompt(btn, planId, currentStintId, nextStint) {
  // currentStint = the stint just finished; we record its actual wear + next stint's incoming tires
  const currentStint = state.activePlan?.stints?.find(s => s.id === currentStintId);
  const existing = {
    cmp:  nextStint.tire_compound || '',
    set:  nextStint.tire_set      || '',
    age:  nextStint.tire_age_laps  != null ? nextStint.tire_age_laps  : '',
    wear: currentStint?.tire_wear_pct != null ? currentStint.tire_wear_pct : '',
  };

  const promptEl = document.createElement('div');
  promptEl.className = 'tire-prompt';
  promptEl.innerHTML = `
    <div class="tp-row">
      <span class="tp-label">Outgoing wear:</span>
      <input type="number" class="tp-wear" value="${existing.wear}" placeholder="%" min="0" max="100" step="0.1" title="Actual wear % on tires coming off" />
      <span class="tp-unit">%</span>
    </div>
    <div class="tp-row">
      <span class="tp-label">Next tires (Stint #${nextStint.stint_num}):</span>
      <select class="tp-cmp">
        <option value="">—</option>
        ${TIRE_OPTS}
      </select>
      <input type="text"   class="tp-set"  value="${existing.set}" placeholder="Set#" maxlength="6" />
      <input type="number" class="tp-age"  value="${existing.age}" placeholder="Age laps" min="0" max="999" />
    </div>
    <div class="tp-row tp-actions">
      <button class="tp-confirm btn-primary">✓ Confirm</button>
      <button class="tp-skip btn-ghost">Skip</button>
    </div>
  `;

  btn.replaceWith(promptEl);

  // pre-select existing compound
  promptEl.querySelector('.tp-cmp').value = existing.cmp;

  async function finish(saveTires) {
    if (saveTires) {
      const cmp  = promptEl.querySelector('.tp-cmp').value;
      const set  = promptEl.querySelector('.tp-set').value.trim();
      const age  = promptEl.querySelector('.tp-age').value;
      const wear = promptEl.querySelector('.tp-wear').value;
      // Save actual wear to the stint that just finished
      if (wear !== '') {
        await saveTireData(planId, currentStintId, {
          tire_wear_pct: parseFloat(wear),
        });
      }
      // Save incoming tire data to the next stint
      await saveTireData(planId, nextStint.id, {
        tire_compound: cmp || null,
        tire_set:      set || null,
        tire_age_laps: age !== '' ? parseInt(age) : null,
      });
    }
    await completStintNow(planId, currentStintId);
  }

  promptEl.querySelector('.tp-confirm').addEventListener('click', () => finish(true));
  promptEl.querySelector('.tp-skip').addEventListener('click',    () => finish(false));
}

// Audio alert — lazy-init AudioContext on first user interaction
let _audioCtx = null;
function _getAudioCtx() {
  if (!_audioCtx) _audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  return _audioCtx;
}
function playPitChime() {
  try {
    const ctx = _getAudioCtx();
    const now = ctx.currentTime;
    [[880, 0], [1100, 0.18], [880, 0.36]].forEach(([freq, offset]) => {
      const osc  = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain); gain.connect(ctx.destination);
      osc.frequency.value = freq;
      osc.type = 'sine';
      gain.gain.setValueAtTime(0.25, now + offset);
      gain.gain.exponentialRampToValueAtTime(0.001, now + offset + 0.15);
      osc.start(now + offset); osc.stop(now + offset + 0.15);
    });
  } catch (_) {}
}

let _lastAlertLap = null;

async function updateLiveStatus() {
  if (!state.activePlan) return;
  const lap = parseInt($('#currentLap').value) || 1;
  const res = await fetch(`/api/plans/${state.activePlan.id}/live_status?lap=${lap}`);
  if (!res.ok) return;
  const data = await res.json();

  const statusEl = $('#liveStatus');
  if (data.status === 'finished') {
    statusEl.innerHTML = '<div class="live-status-block"><p style="color:var(--green);text-align:center;font-weight:700;">RACE COMPLETE</p></div>';
    updatePitWall(null);
    return;
  }

  const s        = data.current_stint;
  const next     = data.next_stint;
  const laps2pit = data.laps_until_pit;
  const alertClass = laps2pit <= 1 ? 'alert-critical' : laps2pit <= 3 ? 'alert-pit' : '';

  // Pit window audio alert — chime once per lap when within window
  if (s.pit_lap && laps2pit <= 3 && laps2pit > 0 && _lastAlertLap !== lap) {
    _lastAlertLap = lap;
    playPitChime();
  }

  // Highlight current stint in list
  $$('.live-stint-item').forEach(item => {
    const start = parseInt(item.dataset.startLap);
    const end   = parseInt(item.dataset.endLap);
    item.classList.toggle('is-current', lap >= start && lap <= end);
  });

  // Fuel display colours
  const fuelPct      = data.fuel_pct ?? 0;
  const fuelBarColor = fuelPct < 20 ? 'var(--red)' : fuelPct < 40 ? 'var(--yellow)' : 'var(--green)';

  statusEl.innerHTML = `
    <div class="live-status-block ${alertClass}">
      <div class="live-stat-row">
        <span class="live-stat-label">Stint</span>
        <span class="live-stat-val">#${s.stint_num} — ${s.driver_name || '—'}</span>
      </div>
      <div class="live-stat-row">
        <span class="live-stat-label">Current Lap</span>
        <span class="live-stat-val">${lap}</span>
      </div>
      <div class="live-stat-row">
        <span class="live-stat-label">Stint Laps</span>
        <span class="live-stat-val">${s.start_lap} → ${s.end_lap}</span>
      </div>
      ${s.pit_lap ? `
      <div class="live-stat-row">
        <span class="live-stat-label">Pit Lap</span>
        <span class="live-stat-val ${laps2pit <= 1 ? 'critical' : laps2pit <= 3 ? 'warning' : 'ok'}">Lap ${s.pit_lap}</span>
      </div>
      <div class="live-stat-row">
        <span class="live-stat-label">Laps Until Pit</span>
        <span class="live-stat-val ${laps2pit <= 1 ? 'critical' : laps2pit <= 3 ? 'warning' : ''}">
          ${laps2pit <= 0 ? 'PIT NOW' : laps2pit}
        </span>
      </div>
      <div class="live-stat-row">
        <span class="live-stat-label">Mins Until Pit</span>
        <span class="live-stat-val">${data.mins_until_pit} min</span>
      </div>
      ` : `<div class="live-stat-row"><span class="live-stat-label">Final stint — no pit</span></div>`}
      <div class="live-stat-divider"></div>
      <div class="live-stat-row">
        <span class="live-stat-label">Est. Fuel</span>
        <span class="live-stat-val" style="color:${fuelBarColor}">${data.fuel_remaining_l} gal</span>
      </div>
      <div class="fuel-mini-bar">
        <div class="fuel-mini-fill" style="width:${fuelPct}%;background:${fuelBarColor}"></div>
      </div>
      <div class="live-stat-row">
        <span class="live-stat-label">Laps of Fuel</span>
        <span class="live-stat-val" style="color:${fuelBarColor}">${data.laps_of_fuel}</span>
      </div>
      ${next ? `
      <div class="live-stat-divider"></div>
      <div class="live-stat-row">
        <span class="live-stat-label">Next Driver</span>
        <span class="live-stat-val"><span class="driver-dot" style="background:${next.driver_color||'#4fc3f7'}"></span>${next.driver_name || '—'}</span>
      </div>
      ` : ''}
      ${s.pit_lap ? `
      <div class="live-stat-divider"></div>
      <div class="pit-window-section">
        <div class="pit-window-label">PIT WINDOW</div>
        <div class="pit-window-row">
          <span class="pw-win-cell pw-win-optimal ${data.pit_window_status === 'green' ? 'pw-active' : ''}">
            <span class="pw-win-icon">◎</span>
            <span class="pw-win-val">Lap ${data.pit_window_optimal}</span>
            <span class="pw-win-lbl">Optimal</span>
          </span>
          <span class="pw-win-cell pw-win-last ${data.pit_window_status === 'red' ? 'pw-active pw-active-red' : ''}">
            <span class="pw-win-icon">⚠</span>
            <span class="pw-win-val">Lap ${data.pit_window_last}</span>
            <span class="pw-win-lbl">Last Safe</span>
          </span>
        </div>
        <div class="pit-window-status-bar">
          <div class="pit-window-fill pw-fill-${data.pit_window_status}"></div>
        </div>
      </div>
      ` : ''}
    </div>
    ${laps2pit <= 3 && laps2pit > 0 ? `<div class="pit-alert-banner pit-alert-pulse">⚑ PIT IN ${laps2pit} LAP${laps2pit === 1 ? '' : 'S'}</div>` : ''}
    ${laps2pit <= 0 && s.pit_lap ? `<div class="pit-alert-banner pit-alert-now">▶ PIT THIS LAP</div>` : ''}
  `;

  updatePitWall(data);

  // Fuel emergency + contingencies buttons (injected once)
  if (!$('#fuelEmergencyBtn')) {
    const liveStatus = $('#liveStatus');
    if (liveStatus) {
      const toolbar = document.createElement('div');
      toolbar.className = 'live-action-toolbar';
      toolbar.innerHTML = `
        <button class="btn-ghost btn-sm" id="fuelEmergencyBtn">⚡ Fuel Emergency</button>
        <button class="btn-ghost btn-sm" id="contingenciesBtn">⇄ Contingencies</button>
      `;
      liveStatus.after(toolbar);
      $('#fuelEmergencyBtn').addEventListener('click', showFuelEmergency);
      $('#contingenciesBtn').addEventListener('click', showContingencies);
    }
  }
}

async function showFuelEmergency() {
  if (!state.activePlan) return;
  const lap = parseInt($('#currentLap').value) || 1;
  try {
    const res = await fetch(`/api/plans/${state.activePlan.id}/fuel_emergency?lap=${lap}`);
    if (!res.ok) return;
    const d = await res.json();
    const panel = $('#fuelEmergencyPanel') || (() => {
      const p = document.createElement('div');
      p.id = 'fuelEmergencyPanel';
      p.className = 'live-panel';
      $('#contingenciesBtn')?.parentElement.after(p);
      return p;
    })();
    const rec = d.recommendation;
    const recColor = rec.level === 'ok' ? 'var(--green)' : rec.level === 'warning' ? 'var(--yellow)' : 'var(--red)';
    panel.innerHTML = `
      <div class="live-panel-header">
        <span>⚡ FUEL EMERGENCY</span>
        <button class="btn-ghost btn-sm" onclick="this.closest('.live-panel').remove()">✕</button>
      </div>
      <p class="live-panel-rec" style="color:${recColor}">${rec.message}</p>
      <div class="fe-scenarios">
        ${d.scenarios.map(s => `
          <div class="fe-row ${s.survives ? '' : 'fe-row-fail'}">
            <span class="fe-mode">${s.mode.toUpperCase()}</span>
            <span class="fe-laps">${s.laps_remaining} laps</span>
            <span class="fe-status">${s.survives ? '✓ OK' : '✗ Short by ' + Math.abs(s.laps_short) + ' laps'}</span>
          </div>
        `).join('')}
      </div>
    `;
    panel.style.display = panel.style.display === 'none' ? 'block' : 'block';
  } catch (_) {}
}

async function showContingencies() {
  if (!state.activePlan) return;
  try {
    const res = await fetch(`/api/plans/${state.activePlan.id}/contingencies`);
    if (!res.ok) return;
    const d = await res.json();
    const panel = $('#contingenciesPanel') || (() => {
      const p = document.createElement('div');
      p.id = 'contingenciesPanel';
      p.className = 'live-panel';
      const toolbar = $('.live-action-toolbar');
      if (toolbar) toolbar.after(p);
      return p;
    })();
    panel.innerHTML = `
      <div class="live-panel-header">
        <span>⇄ CONTINGENCY STRATEGIES</span>
        <button class="btn-ghost btn-sm" onclick="this.closest('.live-panel').remove()">✕</button>
      </div>
      ${['main','save_mode','short_fill'].map(key => {
        const s = d[key];
        if (!s) return '';
        return `
          <div class="ctg-scenario">
            <div class="ctg-name">${s.label}</div>
            <div class="ctg-stats">
              <span>${s.total_stops} stops</span>
              <span>${s.total_laps} laps</span>
              <span>~${s.avg_fuel_per_stop} L/stop</span>
            </div>
            <div class="ctg-note">${s.note || ''}</div>
          </div>
        `;
      }).join('')}
    `;
  } catch (_) {}
}

function updatePitWall(data) {
  const overlay = $('#pitWallOverlay');
  if (!overlay || overlay.style.display === 'none') return;
  if (!data) {
    ['pwStintNum','pwDriver','pwLapsToPit','pwFuel','pwFuelLaps','pwNextDriver']
      .forEach(id => { $('#' + id).textContent = '—'; });
    return;
  }
  const s        = data.current_stint;
  const laps2pit = data.laps_until_pit;
  $('#pwStintNum').textContent   = `STINT #${s.stint_num}`;
  $('#pwDriver').textContent     = s.driver_name || '—';
  $('#pwFuel').textContent       = `${data.fuel_remaining_l} gal`;
  $('#pwFuelLaps').textContent   = String(data.laps_of_fuel);
  $('#pwNextDriver').textContent = data.next_stint?.driver_name || 'FINISH';

  const lapsEl = $('#pwLapsToPit');
  if (!s.pit_lap) {
    lapsEl.textContent = 'FINAL'; lapsEl.className = 'pw-laps pw-laps-ok';
  } else if (laps2pit <= 0) {
    lapsEl.textContent = 'PIT NOW'; lapsEl.className = 'pw-laps pw-laps-critical';
  } else {
    lapsEl.textContent = laps2pit;
    lapsEl.className = `pw-laps ${laps2pit <= 1 ? 'pw-laps-critical' : laps2pit <= 3 ? 'pw-laps-warn' : 'pw-laps-ok'}`;
  }
}

function renderEventLog(events) {
  const el = $('#eventLog');
  if (!events.length) { el.innerHTML = ''; return; }
  el.innerHTML = events.map(e => `
    <div class="event-item">
      <span class="event-lap">Lap ${e.lap}</span>
      <span class="event-type">${e.event_type.toUpperCase()}</span>
      <span>${e.note || ''}</span>
    </div>
  `).join('');
}

// ---------------------------------------------------------------------------
// Lap Times
// ---------------------------------------------------------------------------
async function renderLapTimes(plan) {
  if (!plan) return;

  // Populate driver dropdown, preserving current selection
  const dSel   = $('#lapDriver');
  const prevId = dSel.value;
  dSel.innerHTML = '<option value="">— Select driver —</option>';
  (plan.drivers || []).forEach(d => dSel.add(new Option(d.name, d.id)));
  if (prevId) dSel.value = prevId;

  // Fetch recorded laps
  const res  = await fetch(`/api/plans/${plan.id}/laps`);
  if (!res.ok) return;
  const laps = await res.json();

  // Set lap number input to next expected lap
  if (laps.length) {
    const nextLap = Math.max(...laps.map(l => l.lap_num)) + 1;
    $('#lapNum').value = nextLap;
    autoSelectDriverForLap(plan.stints, nextLap, plan.drivers);
  } else {
    autoSelectDriverForLap(plan.stints, 1, plan.drivers);
  }

  renderLapStats(plan.drivers || [], laps);
  renderLapTable(laps, plan.id);
  checkRestrategize(laps);
}

function autoSelectDriverForLap(stints, lapNum, drivers) {
  if (!stints || !lapNum || !drivers) return;
  const stint = stints.find(s => lapNum >= s.start_lap && lapNum <= s.end_lap);
  if (!stint) return;
  const driver = drivers.find(d => d.name === stint.driver_name);
  if (driver) $('#lapDriver').value = driver.id;
}

function renderLapStats(drivers, laps) {
  const bar = $('#lapStatsBar');
  if (!laps.length) { bar.innerHTML = ''; return; }

  const overallBest = Math.min(...laps.map(l => l.time_s));

  // Aggregate per driver
  const stats = {};
  drivers.forEach(d => { stats[d.id] = { ...d, times: [] }; });
  laps.forEach(l => {
    if (l.driver_id != null && stats[l.driver_id]) {
      stats[l.driver_id].times.push(l.time_s);
    }
  });

  bar.innerHTML = Object.values(stats)
    .filter(d => d.times.length)
    .map(d => {
      const best   = Math.min(...d.times);
      const avg    = d.times.reduce((a, b) => a + b, 0) / d.times.length;
      const isAbsB = best === overallBest;
      return `
        <div class="lap-stat-card">
          <div class="lap-stat-name">
            <span class="driver-dot" style="background:${d.color}"></span>
            ${d.name}
          </div>
          <div class="lap-stat-row"><span>Best</span><strong class="${isAbsB ? 'text-gold' : ''}">${secToMinSecFull(best)}</strong></div>
          <div class="lap-stat-row"><span>Avg</span><strong>${secToMinSecFull(avg)}</strong></div>
          <div class="lap-stat-row"><span>Laps</span><strong>${d.times.length}</strong></div>
        </div>`;
    }).join('');
}

function renderLapTable(laps, planId) {
  const wrap = $('#lapTableWrap');
  if (!laps.length) {
    wrap.innerHTML = '<p class="empty-state" style="padding:1rem">No laps logged yet.</p>';
    return;
  }

  const overallBest = Math.min(...laps.map(l => l.time_s));

  // Personal bests per driver
  const driverBests = {};
  laps.forEach(l => {
    if (l.driver_id == null) return;
    if (!driverBests[l.driver_id] || l.time_s < driverBests[l.driver_id])
      driverBests[l.driver_id] = l.time_s;
  });

  // Newest first
  const sorted = [...laps].sort((a, b) => b.lap_num - a.lap_num);

  let html = `
    <div class="stint-table-wrap">
    <table class="stint-table lap-time-table">
      <thead>
        <tr>
          <th>Lap</th><th>Driver</th><th>Time</th>
          <th>Δ Best</th><th>Note</th><th></th>
        </tr>
      </thead>
      <tbody>
  `;

  sorted.forEach(l => {
    const isOverall = l.time_s === overallBest;
    const isPB      = l.driver_id != null && l.time_s === driverBests[l.driver_id];
    const delta     = l.time_s - overallBest;
    const deltaStr  = isOverall ? 'BEST' : `+${delta.toFixed(3)}`;
    const deltaCls  = isOverall ? 'delta-best' : delta < 1 ? 'delta-close' : delta < 3 ? 'delta-mid' : 'delta-far';
    const rowCls    = isOverall ? 'row-overall-best' : isPB ? 'row-pb' : '';
    const pbTag     = isPB && !isOverall ? '<span class="pb-tag">PB</span>' : '';

    html += `
      <tr class="${rowCls}">
        <td class="lap-num-cell">${l.lap_num}</td>
        <td>
          <span class="driver-dot" style="background:${l.driver_color || '#4fc3f7'}"></span>
          ${l.driver_name || '—'}
        </td>
        <td class="lap-time-cell">${secToMinSecFull(l.time_s)}${pbTag}</td>
        <td class="${deltaCls}">${deltaStr}</td>
        <td class="note-cell">${l.note || ''}</td>
        <td><button class="delete-lap-btn btn-ghost" data-id="${l.id}" title="Delete">✕</button></td>
      </tr>`;
  });

  html += '</tbody></table></div>';
  wrap.innerHTML = html;

  $$('.delete-lap-btn', wrap).forEach(btn => {
    btn.addEventListener('click', async () => {
      if (!state.activePlan) return;
      await fetch(`/api/plans/${state.activePlan.id}/laps/${btn.dataset.id}`, { method: 'DELETE' });
      const r    = await fetch(`/api/plans/${state.activePlan.id}/laps`);
      const laps = await r.json();
      renderLapStats(state.activePlan.drivers || [], laps);
      renderLapTable(laps, state.activePlan.id);
    });
  });
}

async function logLap() {
  if (!state.activePlan) return;
  const driverIdVal = $('#lapDriver').value;
  const lapNum      = parseInt($('#lapNum').value);
  const lapMin      = parseFloat($('#lapMin').value) || 0;
  const lapSec      = parseFloat($('#lapSec').value) || 0;
  const timeS       = lapMin * 60 + lapSec;
  const note        = $('#lapNote').value.trim();

  if (!lapNum || timeS <= 0) return;

  await fetch(`/api/plans/${state.activePlan.id}/laps`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({
      lap_num:   lapNum,
      driver_id: driverIdVal ? parseInt(driverIdVal) : null,
      time_s:    timeS,
      note,
    }),
  });

  const nextLap = lapNum + 1;
  $('#lapNum').value  = nextLap;
  $('#lapSec').value  = '';
  $('#lapNote').value = '';
  autoSelectDriverForLap(state.activePlan.stints, nextLap, state.activePlan.drivers);

  // Refresh only the stats + table, leave the form alone
  const r    = await fetch(`/api/plans/${state.activePlan.id}/laps`);
  const laps = await r.json();
  renderLapStats(state.activePlan.drivers || [], laps);
  renderLapTable(laps, state.activePlan.id);

  $('#lapSec').focus();
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------
function renderExport(plan) {
  const exportEl  = $('#exportContent');
  const actionsEl = $('#exportActions');

  if (!plan || !plan.stints?.length) {
    exportEl.innerHTML = '<p class="empty-state">Load a plan to generate an export.</p>';
    actionsEl.style.display = 'none';
    return;
  }

  const c             = plan.config || {};
  const stints        = plan.stints || [];
  const fuelCap       = c.fuel_capacity_l || 18;
  const lapTimeSec    = c.lap_time_s || 90;
  const fpl           = (c.fuel_per_lap_l || 0.92) * (MODE_MULT[c.fuel_mode] || 1);
  const exportWearRate = c.tire_wear_rate_pct || 0;
  const lapsPerTank = Math.floor((fuelCap - fpl) / fpl);
  const totalLaps  = stints[stints.length - 1]?.end_lap || 0;
  const pitStops   = stints.filter(s => s.pit_lap).length;
  const totalTime  = hrsToHM(c.race_duration_hrs || 0);

  let html = `
    <div class="export-header">
      <h1>${plan.name}</h1>
      <p>Generated ${new Date().toLocaleString()} &nbsp;|&nbsp; Fuel mode: ${(c.fuel_mode || 'normal').toUpperCase()}</p>
    </div>

    <div class="export-meta-grid">
      <div class="export-meta-cell"><span class="val">${totalTime}</span><span class="lbl">Race Duration</span></div>
      <div class="export-meta-cell"><span class="val">${totalLaps}</span><span class="lbl">Est. Total Laps</span></div>
      <div class="export-meta-cell"><span class="val">${stints.length}</span><span class="lbl">Stints</span></div>
      <div class="export-meta-cell"><span class="val">${pitStops}</span><span class="lbl">Pit Stops</span></div>
      <div class="export-meta-cell"><span class="val">${lapsPerTank}</span><span class="lbl">Laps / Tank</span></div>
      <div class="export-meta-cell"><span class="val">${secToMinSec(lapTimeSec)}</span><span class="lbl">Target Lap Time</span></div>
      <div class="export-meta-cell"><span class="val">${fmt(fpl, 3)} gal</span><span class="lbl">Fuel/Lap</span></div>
      <div class="export-meta-cell"><span class="val">${fuelCap} gal</span><span class="lbl">Tank Capacity</span></div>
    </div>

    <div class="export-section-title">Drivers</div>
    <table class="stint-table">
      <thead><tr><th>Driver</th><th>Max Continuous</th></tr></thead>
      <tbody>
        ${(plan.drivers || []).map(d => `
          <tr>
            <td><span class="driver-dot" style="background:${d.color}"></span>${d.name}</td>
            <td>${hrsToHM(d.max_hours)}</td>
          </tr>
        `).join('')}
      </tbody>
    </table>

    <div class="export-section-title">Stint Strategy</div>
    <table class="stint-table">
      <thead>
        <tr>
          <th>#</th><th>Driver</th><th>Tires</th><th>Est. Wear</th><th>Actual Wear</th><th>Start Lap</th><th>End Lap</th>
          <th>Laps</th><th>Stint Time</th><th>Pit Lap</th><th>Fuel Load</th>
        </tr>
      </thead>
      <tbody>
        ${stints.map(s => {
          const laps     = s.end_lap - s.start_lap + 1;
          const stintSec = laps * lapTimeSec;
          const isLast   = !s.pit_lap;
          const tireStr   = s.tire_compound
            ? `${TIRE_LABELS[s.tire_compound] || s.tire_compound}${s.tire_set ? ' / ' + s.tire_set : ''}${s.tire_age_laps != null ? ' (' + s.tire_age_laps + ' laps)' : ''}`
            : '—';
          const sLaps     = s.end_lap - s.start_lap + 1;
          const sAge      = s.tire_age_laps != null ? s.tire_age_laps : 0;
          const sEstWear  = exportWearRate > 0 ? Math.min(Math.round((sAge + sLaps) * exportWearRate), 100) + '%' : '—';
          const sActWear  = s.tire_wear_pct != null ? fmt(s.tire_wear_pct, 0) + '%' : '—';
          return `
            <tr>
              <td>${s.stint_num}</td>
              <td><span class="driver-dot" style="background:${s.driver_color||'#4fc3f7'}"></span>${s.driver_name||'—'}</td>
              <td>${tireStr}</td>
              <td>${sEstWear}</td>
              <td>${sActWear}</td>
              <td>${s.start_lap}</td>
              <td>${s.end_lap}</td>
              <td>${laps}</td>
              <td>${hrsToHM(stintSec/3600)}</td>
              <td>${isLast ? '— FINISH —' : `Lap ${s.pit_lap}`}</td>
              <td>${fmt(s.fuel_load,1)} gal</td>
            </tr>
          `;
        }).join('')}
      </tbody>
    </table>
  `;

  // Lap time summary (fetched async, appended when ready)
  fetch(`/api/plans/${plan.id}/laps`).then(r => r.json()).then(laps => {
    if (!laps.length) return;
    const overallBest = Math.min(...laps.map(l => l.time_s));
    const bestLap     = laps.find(l => l.time_s === overallBest);
    const stats = {};
    (plan.drivers || []).forEach(d => { stats[d.id] = { ...d, times: [] }; });
    laps.forEach(l => { if (l.driver_id != null && stats[l.driver_id]) stats[l.driver_id].times.push(l.time_s); });

    let lapHtml = `
      <div class="export-section-title">Lap Time Summary</div>
      <table class="stint-table">
        <thead><tr><th>Driver</th><th>Laps</th><th>Best</th><th>Average</th><th>Spread</th></tr></thead>
        <tbody>
          ${Object.values(stats).filter(d => d.times.length).map(d => {
            const best   = Math.min(...d.times);
            const avg    = d.times.reduce((a, b) => a + b, 0) / d.times.length;
            const spread = Math.max(...d.times) - Math.min(...d.times);
            return `<tr>
              <td><span class="driver-dot" style="background:${d.color}"></span>${d.name}</td>
              <td>${d.times.length}</td>
              <td>${secToMinSecFull(best)}</td>
              <td>${secToMinSecFull(avg)}</td>
              <td>+${spread.toFixed(3)}s</td>
            </tr>`;
          }).join('')}
        </tbody>
      </table>
      <p style="font-size:0.78rem;color:var(--text-dim);margin-top:0.5rem">
        Overall fastest: <strong>${secToMinSecFull(overallBest)}</strong>
        — ${bestLap.driver_name || '—'}, Lap ${bestLap.lap_num}
      </p>
    `;
    exportEl.innerHTML += lapHtml;
  });

  if (plan.events?.length) {
    html += `
      <div class="export-section-title">Race Events</div>
      <table class="stint-table">
        <thead><tr><th>Lap</th><th>Type</th><th>Note</th></tr></thead>
        <tbody>
          ${plan.events.map(e => `
            <tr>
              <td>${e.lap}</td>
              <td>${e.event_type.toUpperCase()}</td>
              <td>${e.note || ''}</td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    `;
  }

  exportEl.innerHTML   = html;
  actionsEl.style.display = 'flex';
}

// ---------------------------------------------------------------------------
// Telemetry polling & auto-restrategize
// ---------------------------------------------------------------------------
let _telemetryInterval = null;
let _suggestedLapS     = null;   // lap time from restrategize suggestion

async function startTelemetryPolling() {
  if (_telemetryInterval) clearInterval(_telemetryInterval);
  _telemetryInterval = setInterval(pollTelemetry, 4000);
  pollTelemetry();
}

async function pollTelemetry() {
  if (!state.activePlan) return;
  try {
    const res = await fetch(`/api/plans/${state.activePlan.id}/telemetry`);
    if (!res.ok) return;
    const t = await res.json();

    const live  = !t.stale && t.current_lap > 0;
    const dot   = $('#telemetryDot');
    const label = $('#telemetryLabel');
    if (dot)   dot.className   = 'telemetry-dot' + (live ? ' live' : '');
    if (label) label.textContent = live ? '● LIVE' : '○ Telemetry: offline';
    if (label) label.className = 'telemetry-label' + (live ? ' live' : '');

    // Auto-advance current lap from telemetry
    if (live && t.current_lap) {
      const lapInput = $('#currentLap');
      if (lapInput && parseInt(lapInput.value) !== t.current_lap) {
        lapInput.value = t.current_lap;
        updateLiveStatus();
      }
    }

    // Session auto-import banner
    if (t.session_info && !state.sessionImportDismissed) {
      const si = t.session_info;
      let banner = $('#sessionImportBanner');
      if (!banner) {
        banner = document.createElement('div');
        banner.id = 'sessionImportBanner';
        banner.className = 'session-import-banner';
        banner.innerHTML = `
          <span class="si-text">iRacing: <strong>${si.track_name || '?'}</strong> — ${si.series_name || '?'}</span>
          <button class="si-import-btn btn-sm" id="siImportBtn">Import</button>
          <button class="si-dismiss-btn btn-ghost btn-sm" id="siDismissBtn">✕</button>
        `;
        const liveTab = $('#liveTab') || document.querySelector('.tab-content.active');
        if (liveTab) liveTab.prepend(banner);
        $('#siImportBtn')?.addEventListener('click', () => {
          if (state.activePlan) {
            const nameInput = $('#planName');
            if (nameInput && !nameInput.value) nameInput.value = si.track_name || '';
            const trackInput = $('#trackName');
            if (trackInput) trackInput.value = si.track_name || '';
          }
          state.sessionImportDismissed = true;
          banner.remove();
        });
        $('#siDismissBtn')?.addEventListener('click', () => {
          state.sessionImportDismissed = true;
          banner.remove();
        });
      }
    }
  } catch (_) {}
}

function checkRestrategize(laps) {
  // Compare rolling average of last 5 laps vs planned
  if (!state.activePlan || laps.length < 3) return;
  const plan      = state.activePlan;
  const plannedS  = plan.config?.lap_time_s || 90;
  const recent    = laps.slice(-5).map(l => l.time_s);
  const avgS      = recent.reduce((a, b) => a + b, 0) / recent.length;
  const deviationS = avgS - plannedS;

  const banner  = $('#restrategizeBanner');
  const msgEl   = $('#restrategizeMsg');
  if (!banner || !msgEl) return;

  if (Math.abs(deviationS) >= 2.0) {
    const dir  = deviationS > 0 ? 'slower' : 'faster';
    const diff = Math.abs(deviationS).toFixed(1);
    msgEl.textContent = `⚡ Actual pace ${secToMinSec(avgS)} avg — ${diff}s ${dir} than planned. Update strategy?`;
    _suggestedLapS    = avgS;
    banner.style.display = 'flex';
  } else {
    banner.style.display = 'none';
  }
}

// ---------------------------------------------------------------------------
// Competitor Tracker
// ---------------------------------------------------------------------------
let _activeCompetitorId = null;

async function loadCompetitors() {
  if (!state.activePlan) return;
  try {
    const res  = await fetch(`/api/plans/${state.activePlan.id}/competitors`);
    if (!res.ok) return;
    const list = await res.json();
    state.activePlan.competitors = list;
    renderCompetitors(list);
  } catch (_) {}
}

function renderCompetitors(competitors) {
  const el = $('#competitorList');
  if (!el) return;
  const plan  = state.activePlan;
  const lapS  = plan?.config?.lap_time_s || 90;
  const currentLap = parseInt($('#currentLap')?.value) || 1;

  if (!competitors.length) {
    el.innerHTML = '<p class="empty-state">Track competitor pit windows here.</p>';
    return;
  }

  el.innerHTML = competitors.map(c => {
    const lapsSinceLastPit  = c.current_lap % (c.laps_per_tank || 25);
    const lapsUntilPit      = (c.laps_per_tank || 25) - lapsSinceLastPit;
    const windowStatus      = lapsUntilPit <= 2 ? 'critical' : lapsUntilPit <= 5 ? 'warn' : 'ok';
    const windowColor       = windowStatus === 'critical' ? 'var(--red)' : windowStatus === 'warn' ? 'var(--yellow)' : 'var(--green)';

    return `
      <div class="comp-card" data-comp-id="${c.id}">
        <div class="comp-top">
          <span class="comp-num" style="background:${c.color}">#${c.car_num}</span>
          <span class="comp-name">${c.name || 'Unknown'}</span>
          ${c.on_pit_road ? '<span class="comp-pitting-badge">PITTING</span>' : ''}
          <span class="comp-laps-to-pit" style="color:${windowColor}">${lapsUntilPit} to pit</span>
          <button class="comp-uc-btn btn-ghost btn-sm" data-comp-id="${c.id}" data-comp-name="${c.name || c.car_num}" title="Undercut/Overcut calculator">⇄</button>
          <button class="comp-del-btn btn-ghost btn-sm" data-comp-id="${c.id}" title="Remove">✕</button>
        </div>
        <div class="comp-detail">
          <label class="comp-detail-label">Current lap</label>
          <input type="number" class="comp-cur-lap" data-comp-id="${c.id}" value="${c.current_lap}" min="0" />
          <label class="comp-detail-label">Laps/tank</label>
          <input type="number" class="comp-lpt" data-comp-id="${c.id}" value="${c.laps_per_tank}" min="1" max="200" />
        </div>
        <div class="comp-window-bar">
          <div class="comp-window-fill" style="width:${Math.min((lapsSinceLastPit / c.laps_per_tank) * 100, 100)}%;background:${windowColor}"></div>
        </div>
      </div>
    `;
  }).join('');

  // Wire inputs
  $$('.comp-cur-lap', el).forEach(inp => {
    inp.addEventListener('change', async () => {
      const cid = inp.dataset.compId;
      await fetch(`/api/plans/${plan.id}/competitors/${cid}`, {
        method: 'PATCH', headers: {'Content-Type':'application/json'},
        body: JSON.stringify({ current_lap: parseInt(inp.value) || 0 }),
      });
      loadCompetitors();
    });
  });
  $$('.comp-lpt', el).forEach(inp => {
    inp.addEventListener('change', async () => {
      const cid = inp.dataset.compId;
      await fetch(`/api/plans/${plan.id}/competitors/${cid}`, {
        method: 'PATCH', headers: {'Content-Type':'application/json'},
        body: JSON.stringify({ laps_per_tank: parseInt(inp.value) || 25 }),
      });
      loadCompetitors();
    });
  });
  $$('.comp-del-btn', el).forEach(btn => {
    btn.addEventListener('click', async () => {
      await fetch(`/api/plans/${plan.id}/competitors/${btn.dataset.compId}`, { method: 'DELETE' });
      loadCompetitors();
    });
  });
  $$('.comp-uc-btn', el).forEach(btn => {
    btn.addEventListener('click', () => {
      _activeCompetitorId = parseInt(btn.dataset.compId);
      const calcEl = $('#undercutCalc');
      if (calcEl) {
        calcEl.style.display = 'block';
        $('#undercutCompName').textContent = btn.dataset.compName;
        const comp = (state.activePlan?.competitors || []).find(c => c.id === _activeCompetitorId);
        if (comp) {
          const lapsSinceLastPit = comp.current_lap % (comp.laps_per_tank || 25);
          $('#ucCompLaps').value = (comp.laps_per_tank || 25) - lapsSinceLastPit;
        }
      }
    });
  });
}

async function addCompetitor() {
  if (!state.activePlan) return;
  const carNum = prompt('Car number (e.g. 10):');
  if (!carNum) return;
  const name = prompt('Team/driver name (optional):') || '';
  const lpt  = parseInt(prompt('Estimated laps per tank:', '25')) || 25;
  await fetch(`/api/plans/${state.activePlan.id}/competitors`, {
    method: 'POST', headers: {'Content-Type':'application/json'},
    body: JSON.stringify({ car_num: carNum, name, laps_per_tank: lpt }),
  });
  loadCompetitors();
}

async function calcUndercut() {
  const plan    = state.activePlan;
  if (!plan) return;
  const gap     = parseFloat($('#ucGap').value) || 0;
  const ourLaps = parseInt($('#ucOurLaps').value) || 0;
  const cmpLaps = parseInt($('#ucCompLaps').value) || 0;
  const cmpLapT = parseFloat($('#ucCompLapTime').value) || 0;
  const pitLoss = plan.config?.pit_loss_s || 35;
  const lapS    = plan.config?.lap_time_s || 90;

  const res = await fetch('/api/undercut', {
    method: 'POST', headers: {'Content-Type':'application/json'},
    body: JSON.stringify({
      our_gap_s: gap, pit_loss_s: pitLoss,
      our_laps_to_pit: ourLaps, comp_laps_to_pit: cmpLaps,
      lap_time_s: lapS, comp_lap_time_s: cmpLapT,
    }),
  });
  if (!res.ok) return;
  const data = await res.json();

  const posIcon = pos => pos === 'ahead' ? '✅' : pos === 'side-by-side' ? '⚡' : '❌';
  const gapStr  = g => g === 0 ? 'dead even' : g < 0 ? `${Math.abs(g).toFixed(1)}s ahead` : `${g.toFixed(1)}s behind`;

  $('#ucResult').innerHTML = `
    <table class="uc-table">
      <thead><tr><th>Scenario</th><th>Exit</th><th>Result</th></tr></thead>
      <tbody>
        <tr class="${data.undercut.position === 'ahead' ? 'uc-win' : ''}">
          <td>${data.undercut.description}</td>
          <td>${gapStr(data.undercut.exit_gap_s)}</td>
          <td>${posIcon(data.undercut.position)}</td>
        </tr>
        <tr class="${data.planned.position === 'ahead' ? 'uc-win' : ''}">
          <td>${data.planned.description}</td>
          <td>${gapStr(data.planned.exit_gap_s)}</td>
          <td>${posIcon(data.planned.position)}</td>
        </tr>
        <tr class="${data.overcut.position === 'ahead' ? 'uc-win' : ''}">
          <td>${data.overcut.description}</td>
          <td>${gapStr(data.overcut.exit_gap_s)}</td>
          <td>${posIcon(data.overcut.position)}</td>
        </tr>
      </tbody>
    </table>
  `;
}

// ---------------------------------------------------------------------------
// Post-Race Debrief
// ---------------------------------------------------------------------------
async function renderDebrief(plan) {
  const el = $('#debriefContent');
  if (!el) return;
  if (!plan || !plan.stints?.length) {
    el.innerHTML = '<p class="empty-state">Load a completed plan to view debrief.</p>';
    return;
  }

  el.innerHTML = '<p class="empty-state" style="padding:1rem">Loading debrief…</p>';

  try {
    const res  = await fetch(`/api/plans/${plan.id}/debrief`);
    if (!res.ok) { el.innerHTML = '<p class="empty-state">Failed to load debrief.</p>'; return; }
    const data = await res.json();
    const plannedS = data.planned_lap_s || 90;

    let html = `<div class="debrief-grid">`;

    // ── Driver summary cards ────────────────────────────────────────────
    if (data.driver_stats?.length) {
      html += `<div class="debrief-section"><h3>Driver Performance</h3><div class="debrief-driver-cards">`;
      data.driver_stats.forEach(d => {
        const avgDelta  = d.avg - plannedS;
        const deltaStr  = `${avgDelta >= 0 ? '+' : ''}${avgDelta.toFixed(3)}s vs plan`;
        const deltaCls  = Math.abs(avgDelta) < 0.5 ? 'delta-ok' : avgDelta > 0 ? 'delta-over' : 'delta-under';
        const stdDev    = d.std_dev.toFixed(3);
        const consistency = d.std_dev < 0.5 ? 'Excellent' : d.std_dev < 1.5 ? 'Good' : d.std_dev < 3 ? 'Moderate' : 'Inconsistent';
        const consCls   = d.std_dev < 0.5 ? 'cons-excellent' : d.std_dev < 1.5 ? 'cons-good' : d.std_dev < 3 ? 'cons-mod' : 'cons-poor';
        html += `
          <div class="debrief-driver-card">
            <div class="ddb-header">
              <span class="driver-dot" style="background:${d.color}"></span>
              <strong>${d.name}</strong>
              <span class="ddb-laps">${d.laps} laps</span>
            </div>
            <div class="ddb-row"><span>Best</span><strong>${secToMinSecFull(d.best)}</strong></div>
            <div class="ddb-row"><span>Average</span>
              <strong>${secToMinSecFull(d.avg)} <span class="${deltaCls}" style="font-size:0.72rem">${deltaStr}</span></strong>
            </div>
            <div class="ddb-row"><span>Worst</span><strong>${secToMinSecFull(d.worst)}</strong></div>
            <div class="ddb-row"><span>Std Dev</span><strong>±${stdDev}s</strong></div>
            <div class="ddb-row"><span>Consistency</span>
              <strong class="${consCls}">${consistency}</strong>
            </div>
          </div>`;
      });
      html += `</div></div>`;
    }

    // ── Stint comparison table ──────────────────────────────────────────
    html += `
      <div class="debrief-section">
        <h3>Stint vs Plan</h3>
        <div class="stint-table-wrap">
        <table class="stint-table">
          <thead>
            <tr>
              <th>#</th><th>Driver</th>
              <th>Planned Laps</th><th>Actual Laps</th><th>Lap Δ</th>
              <th>Planned Fuel</th><th>Actual Fuel</th><th>Fuel Δ</th>
              <th>Avg Pace</th><th>Pace Δ</th>
            </tr>
          </thead>
          <tbody>`;

    data.stints.forEach(s => {
      const lapDeltaCls  = s.lap_delta === 0 ? '' : s.lap_delta > 0 ? 'delta-over' : 'delta-under';
      const fuelDeltaCls = !s.fuel_delta ? '' : Math.abs(s.fuel_delta) < 0.5 ? 'delta-ok' : s.fuel_delta > 0 ? 'delta-over' : 'delta-under';
      const paceDeltaCls = !s.pace_delta_s ? '' : Math.abs(s.pace_delta_s) < 0.5 ? 'delta-ok' : s.pace_delta_s > 0 ? 'delta-over' : 'delta-under';
      html += `
        <tr>
          <td>${s.stint_num}</td>
          <td><span class="driver-dot" style="background:${s.driver_color||'#4fc3f7'}"></span>${s.driver_name||'—'}</td>
          <td>${s.planned_laps}</td>
          <td>${s.actual_laps}</td>
          <td class="${lapDeltaCls}">${s.lap_delta >= 0 ? '+' : ''}${s.lap_delta}</td>
          <td>${fmt(s.planned_fuel, 1)} gal</td>
          <td>${s.actual_fuel != null ? fmt(s.actual_fuel, 1) + ' gal' : '—'}</td>
          <td class="${fuelDeltaCls}">${s.fuel_delta != null ? (s.fuel_delta >= 0 ? '+' : '') + fmt(s.fuel_delta, 1) : '—'}</td>
          <td>${s.avg_lap_time_s ? secToMinSecFull(s.avg_lap_time_s) : '—'}</td>
          <td class="${paceDeltaCls}">${s.pace_delta_s != null ? (s.pace_delta_s >= 0 ? '+' : '') + s.pace_delta_s.toFixed(2) + 's' : '—'}</td>
        </tr>`;
    });

    html += `</tbody></table></div></div></div>`;
    el.innerHTML = html;
  } catch (err) {
    el.innerHTML = `<p class="empty-state">Error: ${err.message}</p>`;
  }
}

// ---------------------------------------------------------------------------
// What-if Calculator (pure client-side)
// ---------------------------------------------------------------------------
function calcWhatIf() {
  const plan = state.activePlan;
  if (!plan || !plan.stints?.length) return;

  const fromLap  = parseInt($('#whatifLap').value) || 1;
  const fuelLeft = parseFloat($('#whatifFuel').value);
  const result   = $('#whatifResult');

  const config      = plan.config || {};
  const fuelCap     = config.fuel_capacity_l || 18;
  const globalLapS  = config.lap_time_s || 90;
  const globalFpl   = (config.fuel_per_lap_l || 0.92) * (MODE_MULT[config.fuel_mode] || 1);
  const raceDurS    = (config.race_duration_hrs || 6) * 3600;
  const pitLossS    = config.pit_loss_s || 35;
  const maxContHrs  = config.max_continuous_hrs || 2.5;
  const driversMap  = {};
  (plan.drivers || []).forEach(d => { driversMap[d.id] = d; });

  // Determine which stint fromLap is in and which driver index that corresponds to
  const stints = plan.stints || [];
  const curStint = stints.find(s => fromLap >= s.start_lap && fromLap <= s.end_lap);
  if (!curStint) {
    result.innerHTML = '<span class="msg-error">Lap not found in plan stints.</span>';
    return;
  }

  // Estimate elapsed race time up to fromLap
  let elapsedS = 0;
  for (const s of stints) {
    if (s.start_lap >= fromLap) break;
    const d     = driversMap[s.driver_id];
    const lapS  = (d && d.target_lap_s > 0) ? d.target_lap_s : globalLapS;
    const laps  = Math.min(s.end_lap, fromLap - 1) - s.start_lap + 1;
    if (laps > 0) elapsedS += laps * lapS;
  }

  // Find driver rotation index starting from current stint
  const driverList = plan.drivers || [];
  const curDriverIdx = driverList.findIndex(d => d.id === curStint.driver_id);
  const nDrivers = driverList.length || 1;

  // Run forward simulation
  const projStints = [];
  let currentLap  = fromLap;
  let totalTimeS  = elapsedS;
  let driverIdx   = curDriverIdx >= 0 ? curDriverIdx : 0;
  let stintNum    = curStint.stint_num;
  // Remaining fuel in current tank
  const lapsIntoCurStint = fromLap - curStint.start_lap;
  const curD   = driversMap[curStint.driver_id];
  const curFpl = isNaN(fuelLeft)
    ? (() => {
        const d = curD && curD.target_fpl > 0 ? curD.target_fpl : (config.fuel_per_lap_l || 0.92);
        return d * (MODE_MULT[config.fuel_mode] || 1);
      })()
    : null;
  const usableFuelNow = isNaN(fuelLeft)
    ? Math.max((curStint.fuel_load || 0) - lapsIntoCurStint * curFpl, 0)
    : fuelLeft;

  // First "virtual" stint: remaining laps on current tank
  const firstDriver = driverList[driverIdx % nDrivers];
  const firstLapS   = (firstDriver && firstDriver.target_lap_s > 0) ? firstDriver.target_lap_s : globalLapS;
  const firstFpl    = (firstDriver && firstDriver.target_fpl > 0)
    ? firstDriver.target_fpl * (MODE_MULT[config.fuel_mode] || 1)
    : globalFpl;
  const firstFuelLaps = firstFpl > 0 ? Math.floor(usableFuelNow / firstFpl) : 999;
  const firstFatigue  = Math.floor(maxContHrs * 3600 / firstLapS);
  const firstRemain   = Math.floor((raceDurS - totalTimeS) / firstLapS);
  const firstStintLaps = Math.max(Math.min(firstFuelLaps, firstFatigue, firstRemain), 0);

  if (firstStintLaps > 0) {
    projStints.push({
      stint_num:   stintNum,
      driver_name: firstDriver?.name || '—',
      driver_color: firstDriver?.color || '#4fc3f7',
      start_lap:   currentLap,
      end_lap:     currentLap + firstStintLaps - 1,
      fuel_load:   Math.min(usableFuelNow, fuelCap),
      is_last:     firstRemain <= firstStintLaps,
    });
    totalTimeS  += firstStintLaps * firstLapS;
    currentLap  += firstStintLaps;
    stintNum++;
    driverIdx++;
  }

  // Remaining stints from full tanks
  while (true) {
    const d       = driverList[driverIdx % nDrivers];
    const lapS    = (d && d.target_lap_s > 0) ? d.target_lap_s : globalLapS;
    const fpl     = (d && d.target_fpl > 0)
      ? d.target_fpl * (MODE_MULT[config.fuel_mode] || 1)
      : globalFpl;
    const usable    = fuelCap - fpl;
    const fuelLaps  = fpl > 0 ? Math.floor(usable / fpl) : 999;
    const fatigue   = Math.floor(maxContHrs * 3600 / lapS);
    const remaining = Math.floor((raceDurS - totalTimeS) / lapS);
    if (remaining <= 0) break;
    const stintLaps = Math.min(fuelLaps, fatigue, remaining);
    const isLast    = remaining <= stintLaps;
    projStints.push({
      stint_num:    stintNum,
      driver_name:  d?.name || '—',
      driver_color: d?.color || '#4fc3f7',
      start_lap:    currentLap,
      end_lap:      currentLap + stintLaps - 1,
      fuel_load:    Math.min(stintLaps * fpl + fpl, fuelCap),
      is_last:      isLast,
    });
    totalTimeS += stintLaps * lapS;
    currentLap += stintLaps;
    stintNum++;
    driverIdx++;
  }

  if (!projStints.length) {
    result.innerHTML = '<span style="color:var(--green)">Race appears complete from this lap.</span>';
    return;
  }

  const pitCount  = projStints.filter(s => !s.is_last).length;
  const totalLaps = projStints[projStints.length - 1]?.end_lap || fromLap;

  result.innerHTML = `
    <div class="whatif-meta">
      <span>From lap <strong>${fromLap}</strong></span>
      <span><strong>${projStints.length}</strong> stints remaining</span>
      <span><strong>${pitCount}</strong> more pit stops</span>
      <span>Finish ~lap <strong>${totalLaps}</strong></span>
    </div>
    <table class="whatif-table">
      <thead><tr><th>#</th><th>Driver</th><th>Laps</th><th>Fuel</th></tr></thead>
      <tbody>
        ${projStints.map(s => `
          <tr class="${s.is_last ? 'last-stint' : ''}">
            <td>${s.stint_num}</td>
            <td><span class="driver-dot" style="background:${s.driver_color}"></span>${s.driver_name}</td>
            <td>${s.start_lap}–${s.end_lap} (${s.end_lap - s.start_lap + 1})</td>
            <td>${fmt(s.fuel_load, 1)} gal${s.is_last ? ' <span class="no-pit-badge">FINISH</span>' : ''}</td>
          </tr>`).join('')}
      </tbody>
    </table>
  `;
}

// ---------------------------------------------------------------------------
// Rotation Optimizer
// ---------------------------------------------------------------------------
async function optimizeRotation() {
  const plan = state.activePlan;
  if (!plan) return;

  const resultEl = $('#optimizeResult');
  resultEl.style.display = 'block';
  resultEl.innerHTML = '<span style="color:var(--text-dim)">Calculating…</span>';

  // Ask user for mode
  const mode = confirm(
    'Choose optimization goal:\n\nOK = Minimize pit stops\nCancel = Balance driver hours'
  ) ? 'minimize_pits' : 'balance_hours';

  try {
    const res  = await fetch(`/api/plans/${plan.id}/optimize`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ mode }),
    });
    if (!res.ok) {
      const err = await res.json();
      resultEl.innerHTML = `<span class="msg-error">${err.error || 'Optimization failed'}</span>`;
      return;
    }
    const data = await res.json();
    const orderStr = data.best_order.join(' → ');
    resultEl.innerHTML = `
      <div class="optimize-info">
        <strong>Best order:</strong> ${orderStr}
        &nbsp;|&nbsp; <strong>${data.pit_stops}</strong> pit stops
        &nbsp;|&nbsp; <strong>${data.total_stints}</strong> stints
        <button class="btn-primary btn-sm" id="applyOptBtn">Apply this rotation</button>
      </div>
    `;

    $('#applyOptBtn').addEventListener('click', async () => {
      // Reorder driver list in setup form to match best_order, then recalculate
      const driverRows    = $$('.driver-row');
      const currentDrivers = buildDrivers();
      const nameToDriver   = {};
      currentDrivers.forEach((d, i) => { nameToDriver[d.name] = { ...d, row: driverRows[i] }; });

      const list = $('#driverList');
      list.innerHTML = '';
      data.best_order.forEach(name => {
        const d = nameToDriver[name];
        if (d) addDriverRow(d);
      });
      // Add any drivers not in the optimized list (shouldn't happen, but safe)
      currentDrivers.forEach(d => {
        if (!data.best_order.includes(d.name)) addDriverRow(d);
      });

      resultEl.innerHTML = '<span style="color:var(--green)">Rotation applied — click Calculate Strategy to save.</span>';
    });
  } catch (err) {
    resultEl.innerHTML = `<span class="msg-error">Error: ${err.message}</span>`;
  }
}

// ---------------------------------------------------------------------------
// CSV Lap Import
// ---------------------------------------------------------------------------
function parseTimeToSec(str) {
  str = str.trim();
  // m:ss.ttt
  const colonMatch = str.match(/^(\d+):(\d+(?:\.\d+)?)$/);
  if (colonMatch) return parseFloat(colonMatch[1]) * 60 + parseFloat(colonMatch[2]);
  // plain seconds
  const numVal = parseFloat(str);
  return isNaN(numVal) ? null : numVal;
}

async function importCsvLaps(file) {
  if (!state.activePlan) {
    alert('Load a plan first before importing laps.');
    return;
  }
  const text = await file.text();
  const lines = text.split(/\r?\n/).map(l => l.trim()).filter(l => l && !l.startsWith('#'));
  if (!lines.length) return;

  // Detect header row (first cell not a number)
  let dataLines = lines;
  if (isNaN(parseInt(lines[0].split(',')[0]))) {
    dataLines = lines.slice(1);
  }

  const laps = [];
  for (const line of dataLines) {
    const cols = line.split(',').map(c => c.trim().replace(/^"|"$/g, ''));
    const lapNum = parseInt(cols[0]);
    const timeS  = parseTimeToSec(cols[1] || '');
    if (!lapNum || !timeS) continue;
    laps.push({
      lap_num:     lapNum,
      time_s:      timeS,
      driver_name: cols[2] || null,
      note:        cols[3] || null,
    });
  }

  if (!laps.length) {
    alert('No valid lap rows found. Expected format: Lap, Time (m:ss.ttt), Driver (opt), Note (opt)');
    return;
  }

  const res = await fetch(`/api/plans/${state.activePlan.id}/laps/import`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ laps }),
  });
  if (!res.ok) {
    alert('Import failed — server error.');
    return;
  }
  const data = await res.json();
  alert(`Imported ${data.inserted} laps successfully.`);

  // Refresh lap times view
  const updated = await (await fetch(`/api/plans/${state.activePlan.id}`)).json();
  state.activePlan = updated;
  renderLapTimes(updated);
}

// ---------------------------------------------------------------------------
// Event wiring
// ---------------------------------------------------------------------------
function initEvents() {
  // Fuel mode toggle
  $$('.mode-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      $$('.mode-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      state.fuelMode = btn.dataset.mode;
      updateFuelPreview();
    });
  });

  // Live preview updates
  ['#fuelCapacity','#fuelPerLap','#lapTimeMin','#lapTimeSec'].forEach(sel => {
    $(sel).addEventListener('input', updateFuelPreview);
  });

  // Race duration preset
  $('#raceDurationPreset').addEventListener('change', function() {
    if (this.value) $('#raceDuration').value = this.value;
  });
  $('#raceDuration').addEventListener('input', () => {
    $('#raceDurationPreset').value = '';
    updateFuelPreview();
  });

  // Add driver
  $('#addDriverBtn').addEventListener('click', () => addDriverRow());

  // Calculate / save
  $('#calculateBtn').addEventListener('click', calculateStrategy);
  $('#saveSetupBtn').addEventListener('click',  saveSetup);

  // Plan selector
  $('#planSelect').addEventListener('change', function() {
    if (this.value) loadPlan(this.value);
    else {
      state.activePlan = null;
      $('#driverList').innerHTML = '';
      addDriverRow();
      addDriverRow();
      updateFuelPreview();
    }
  });

  // Delete plan
  $('#deletePlanBtn').addEventListener('click', async () => {
    if (!state.activePlan) return;
    if (!confirm(`Delete "${state.activePlan.name}"?`)) return;
    await fetch(`/api/plans/${state.activePlan.id}`, { method: 'DELETE' });
    state.activePlan = null;
    $('#planSelect').value = '';
    await loadPlanList();
    $('#stintTableWrap').innerHTML = '<p class="empty-state">Configure your race in Setup, then click "Calculate Strategy".</p>';
    $('#strategyMeta').innerHTML   = '';
  });

  // Live mode — update button
  $('#updateLapBtn').addEventListener('click', () => {
    if (!state.activePlan) return;
    updateLiveStatus();
  });

  // Laps tab
  $('#lapNum').addEventListener('input', () => {
    if (state.activePlan) {
      autoSelectDriverForLap(
        state.activePlan.stints,
        parseInt($('#lapNum').value),
        state.activePlan.drivers
      );
    }
  });
  $('#lapSec').addEventListener('keydown', e => { if (e.key === 'Enter') logLap(); });
  $('#logLapBtn').addEventListener('click', logLap);

  // Car preset — pre-fills tank capacity and fuel per lap
  $('#carPreset').addEventListener('change', function() {
    const preset = CAR_PRESETS[this.value];
    if (!preset) return;
    $('#fuelCapacity').value = preset.tank;
    $('#fuelPerLap').value   = preset.fpl;
    updateFuelPreview();
    // Reset select so user can reapply if needed
    this.value = '';
  });

  // Pit wall mode toggle
  $('#pitWallBtn').addEventListener('click', () => {
    const overlay = $('#pitWallOverlay');
    overlay.style.display = 'flex';
    // Sync lap input
    $('#pwCurrentLap').value = $('#currentLap').value || 1;
    updateLiveStatus();
  });
  $('#pitWallClose').addEventListener('click', () => {
    $('#pitWallOverlay').style.display = 'none';
  });
  $('#pwUpdateBtn').addEventListener('click', () => {
    $('#currentLap').value = $('#pwCurrentLap').value;
    updateLiveStatus();
  });
  $('#pwCurrentLap').addEventListener('keydown', e => {
    if (e.key === 'Enter') {
      $('#currentLap').value = $('#pwCurrentLap').value;
      updateLiveStatus();
    }
  });

  // Optimize rotation
  $('#optimizeBtn').addEventListener('click', optimizeRotation);

  // What-if calculator
  $('#whatifBtn').addEventListener('click', calcWhatIf);

  // CSV import
  $('#importCsvInput').addEventListener('change', function() {
    if (this.files[0]) importCsvLaps(this.files[0]);
    this.value = '';
  });

  // Restrategize banner
  $('#restrategizeBtn').addEventListener('click', async () => {
    if (!state.activePlan || !_suggestedLapS) return;
    const res = await fetch(`/api/plans/${state.activePlan.id}/restrategize`, {
      method: 'POST', headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ new_lap_time_s: _suggestedLapS }),
    });
    if (!res.ok) return;
    const plan = await res.json();
    state.activePlan = plan;
    renderStintTable(plan);
    $('#restrategizeBanner').style.display = 'none';
    // Switch to stint tab to show updated plan
    $$('.tab-btn').forEach(b => b.classList.remove('active'));
    $$('.tab-section').forEach(s => s.classList.remove('active'));
    $('[data-tab="stint"]').classList.add('active');
    $('#tab-stint').classList.add('active');
  });
  $('#restrategizeDismiss').addEventListener('click', () => {
    $('#restrategizeBanner').style.display = 'none';
  });

  // Competitor tracker
  $('#addCompetitorBtn').addEventListener('click', addCompetitor);
  $('#ucCalcBtn').addEventListener('click', calcUndercut);

  // Log event
  $('#logEventBtn').addEventListener('click', async () => {
    if (!state.activePlan) return;
    const lap  = parseInt($('#eventLap').value);
    const type = $('#eventType').value;
    const note = $('#eventNote').value.trim();
    if (!lap) return;
    await fetch(`/api/plans/${state.activePlan.id}/events`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ lap, event_type: type, note }),
    });
    const updated = await (await fetch(`/api/plans/${state.activePlan.id}`)).json();
    state.activePlan = updated;
    renderEventLog(updated.events || []);
    $('#eventNote').value = '';
  });
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
async function boot() {
  initTabs();
  initEvents();

  // seed two blank driver rows
  addDriverRow();
  addDriverRow();

  updateFuelPreview();
  await checkAuthOnBoot();
  await loadPlanList();

  // auto-load the most recent plan if any
  const sel = $('#planSelect');
  if (sel.options.length > 1) {
    sel.selectedIndex = 1;
    await loadPlan(sel.value);
  }
}

document.addEventListener('DOMContentLoaded', boot);

// =============================================================================
// AUTH
// =============================================================================
function openAuth()  { $('#authOverlay').classList.add('open'); }
function closeAuth() { $('#authOverlay').classList.remove('open'); }

function switchAuthTab(tab) {
  ['login','register','join'].forEach(t => {
    const form = $(`#authForm${t.charAt(0).toUpperCase()+t.slice(1)}`);
    const btn  = $(`#authTab${t.charAt(0).toUpperCase()+t.slice(1)}`);
    if (form) form.style.display = t === tab ? '' : 'none';
    if (btn)  btn.classList.toggle('active', t === tab);
  });
  // Hide invite section when switching tabs
  const inv = $('#authInviteSection');
  if (inv) inv.style.display = 'none';
}

async function doLogin() {
  const email    = $('#loginEmail').value.trim();
  const password = $('#loginPassword').value;
  $('#loginError').textContent = '';
  try {
    const res = await fetch('/auth/login', {
      method: 'POST', headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ email, password }),
    });
    const d = await res.json();
    if (!res.ok) { $('#loginError').textContent = d.error; return; }
    // Fetch invite code separately since login response doesn't include it
    const me = await (await fetch('/auth/me')).json();
    setAuthState(d.team_name, d.display_name, me.invite_code);
    closeAuth();
    await loadPlanList();
  } catch(e) { $('#loginError').textContent = 'Connection error'; }
}

async function doRegister() {
  const team_name    = $('#regTeam').value.trim();
  const display_name = $('#regName').value.trim();
  const email        = $('#regEmail').value.trim();
  const password     = $('#regPassword').value;
  $('#registerError').textContent = '';
  try {
    const res = await fetch('/auth/register', {
      method: 'POST', headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ team_name, display_name, email, password }),
    });
    const d = await res.json();
    if (!res.ok) { $('#registerError').textContent = d.error; return; }
    const me = await (await fetch('/auth/me')).json();
    setAuthState(d.team_name, d.display_name, me.invite_code);
    closeAuth();
    await loadPlanList();
  } catch(e) { $('#registerError').textContent = 'Connection error'; }
}

async function doJoinTeam() {
  const invite_code  = $('#joinCode').value.trim().toUpperCase();
  const display_name = $('#joinName').value.trim();
  const email        = $('#joinEmail').value.trim();
  const password     = $('#joinPassword').value;
  $('#joinError').textContent = '';
  if (!invite_code || invite_code.length !== 8) {
    $('#joinError').textContent = 'Enter the 8-character invite code from your team owner.';
    return;
  }
  try {
    const res = await fetch('/auth/register', {
      method: 'POST', headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ invite_code, display_name, email, password }),
    });
    const d = await res.json();
    if (!res.ok) { $('#joinError').textContent = d.error; return; }
    const me = await (await fetch('/auth/me')).json();
    setAuthState(d.team_name, d.display_name, me.invite_code);
    closeAuth();
    await loadPlanList();
  } catch(e) { $('#joinError').textContent = 'Connection error'; }
}

async function doLogout() {
  await fetch('/auth/logout', { method: 'POST' });
  setAuthState(null, null, null);
  closeAuth();
  await loadPlanList();
}

let _inviteCode = null;

function setAuthState(teamName, displayName, inviteCode) {
  const badge = $('#authTeamBadge');
  const btn   = $('#authBtn');
  _inviteCode = inviteCode || null;
  if (teamName) {
    badge.textContent = teamName;
    badge.style.display = '';
    btn.textContent = 'Team';
    btn.onclick = openAuth;
  } else {
    badge.style.display = 'none';
    btn.textContent = 'Sign In';
    btn.onclick = openAuth;
  }
}

function openAuth() {
  $('#authOverlay').classList.add('open');
  // If logged in, show the invite code panel instead of tabs
  if (_inviteCode) {
    ['login','register','join'].forEach(t => {
      const form = $(`#authForm${t.charAt(0).toUpperCase()+t.slice(1)}`);
      if (form) form.style.display = 'none';
      const btn = $(`#authTab${t.charAt(0).toUpperCase()+t.slice(1)}`);
      if (btn) btn.classList.remove('active');
    });
    const inv = $('#authInviteSection');
    if (inv) inv.style.display = '';
    const display = $('#inviteCodeDisplay');
    if (display) display.textContent = _inviteCode;
  } else {
    switchAuthTab('login');
  }
}

function copyInviteCode() {
  if (!_inviteCode) return;
  navigator.clipboard.writeText(_inviteCode).then(() => {
    const btn = $('#copyCodeBtn');
    if (btn) { btn.textContent = 'Copied!'; setTimeout(() => btn.textContent = 'Copy', 2000); }
  });
}

async function checkAuthOnBoot() {
  try {
    const res = await fetch('/auth/me');
    const d   = await res.json();
    if (d.logged_in) setAuthState(d.team_name, d.display_name, d.invite_code);
  } catch(_) {}
}

document.addEventListener('DOMContentLoaded', () => {
  $('#authBtn')?.addEventListener('click', openAuth);
  $('#authOverlay')?.addEventListener('click', e => { if (e.target === $('#authOverlay')) closeAuth(); });
});

// =============================================================================
// RACE TIMELINE (Gantt chart)
// =============================================================================
function renderTimeline(plan) {
  const el = $('#timelineChart');
  if (!el) return;
  const stints  = plan.stints || [];
  const drivers = plan.drivers || [];
  if (!stints.length) {
    el.innerHTML = '<p class="empty-state">Calculate a strategy first to see the timeline.</p>';
    return;
  }

  const totalLaps = Math.max(...stints.map(s => s.end_lap || s.start_lap), 1);
  const currentLap = parseInt($('#currentLap')?.value) || 0;

  // Group stints by driver
  const byDriver = {};
  stints.forEach(s => {
    const key = s.driver_name || 'Unknown';
    if (!byDriver[key]) byDriver[key] = { name: key, color: s.driver_color || '#C49A3C', stints: [] };
    byDriver[key].stints.push(s);
  });

  // Build axis ticks
  const tickStep = totalLaps <= 50 ? 10 : totalLaps <= 100 ? 20 : totalLaps <= 200 ? 25 : 50;
  let ticks = '';
  for (let lap = 0; lap <= totalLaps; lap += tickStep) {
    const pct = (lap / totalLaps) * 100;
    ticks += `<span class="timeline-lap-tick" style="left:${pct}%">${lap}</span>`;
  }

  // Build driver rows
  const rows = Object.values(byDriver).map(driver => {
    const bars = driver.stints.map(s => {
      const left  = ((s.start_lap - 1) / totalLaps) * 100;
      const width = Math.max(((s.end_lap - s.start_lap + 1) / totalLaps) * 100, 0.5);
      const mode  = s.fuel_mode === 'save' ? '⬇' : s.fuel_mode === 'push' ? '⬆' : '';
      return `<div class="timeline-stint-bar" style="left:${left.toFixed(2)}%;width:${width.toFixed(2)}%;background:${driver.color}"
                   title="Stint #${s.stint_num}: Laps ${s.start_lap}–${s.end_lap} | Fuel: ${s.fuel_load}L | ${s.fuel_mode}">
                ${s.stint_num}${mode}
              </div>`;
    }).join('');

    const pitMarkers = driver.stints.filter(s => s.pit_lap).map(s => {
      const pct = (s.pit_lap / totalLaps) * 100;
      return `<div class="timeline-pit-marker" style="left:${pct.toFixed(2)}%" title="Pit lap ${s.pit_lap}"></div>`;
    }).join('');

    return `
      <div class="timeline-driver-row">
        <div class="timeline-driver-label" title="${driver.name}">${driver.name}</div>
        <div class="timeline-track">
          ${bars}${pitMarkers}
          ${currentLap > 0 ? `<div class="timeline-now-line" style="left:${((currentLap/totalLaps)*100).toFixed(2)}%" title="Lap ${currentLap}"></div>` : ''}
        </div>
      </div>`;
  }).join('');

  // Legend
  const legend = Object.values(byDriver).map(d =>
    `<span class="timeline-legend-item"><span class="timeline-legend-dot" style="background:${d.color}"></span>${d.name}</span>`
  ).join('') + `
    <span class="timeline-legend-item"><span class="timeline-legend-dot" style="background:var(--text-dim);opacity:0.4"></span>Pit stop</span>
    ${currentLap > 0 ? '<span class="timeline-legend-item"><span class="timeline-legend-dot" style="background:var(--accent)"></span>Current lap</span>' : ''}`;

  el.innerHTML = `
    <div class="timeline-chart">
      <div class="timeline-lap-axis">${ticks}</div>
      ${rows}
      <div class="timeline-legend">${legend}</div>
    </div>`;
}

// =============================================================================
// FUEL DELTA PANEL
// =============================================================================
function renderFuelDelta(fuelDelta, plannedFpl) {
  const container = $('#fuelDeltaPanel');
  if (!container || !fuelDelta) return;

  const avg    = fuelDelta.avg_actual_fpl;
  const last   = fuelDelta.last_actual_fpl;
  if (!avg) { container.innerHTML = ''; return; }

  const delta     = avg - plannedFpl;
  const deltaPct  = Math.min(Math.abs(delta / plannedFpl) * 100, 50);
  const overUnder = Math.abs(delta) < 0.02 ? 'ok' : delta > 0 ? 'over' : 'under';
  const sign      = delta > 0 ? '+' : '';
  const barLeft   = delta > 0 ? '50%' : `${50 - deltaPct}%`;
  const barColor  = overUnder === 'ok' ? 'var(--text-dim)' : overUnder === 'over' ? 'var(--red)' : 'var(--green)';

  container.innerHTML = `
    <div class="fuel-delta-bar">
      <span class="fuel-delta-label">FUEL Δ/LAP</span>
      <span class="fuel-delta-value ${overUnder}">${sign}${delta.toFixed(3)} L</span>
      <div class="fuel-delta-track">
        <div class="fuel-delta-center"></div>
        <div class="fuel-delta-fill" style="left:${barLeft};width:${deltaPct}%;background:${barColor}"></div>
      </div>
      <span class="fuel-delta-note">Avg ${avg.toFixed(3)} L/lap vs plan ${plannedFpl.toFixed(3)}</span>
    </div>`;
}

// =============================================================================
// PIT STOP STOPWATCH PANEL
// =============================================================================
async function loadPitStopPanel() {
  if (!state.activePlan) return;
  const container = $('#pitStopPanel');
  if (!container) return;
  try {
    const res = await fetch(`/api/plans/${state.activePlan.id}/pit_stops`);
    if (!res.ok) return;
    const d = await res.json();
    if (!d.count) { container.innerHTML = ''; return; }

    const historyRows = d.stops.slice(0, 5).map(s =>
      `<div class="pit-stop-row"><span>Lap ${s.entry_lap}</span><span>${s.duration_s}s</span></div>`
    ).join('');

    container.innerHTML = `
      <div class="pit-stop-panel">
        <div class="pit-stop-header">&#9646; PIT STOP TIMES</div>
        <div class="pit-stop-stats">
          <div class="pit-stop-stat">
            <span class="pit-stop-stat-val">${d.best_s}s</span>
            <span class="pit-stop-stat-lbl">Best</span>
          </div>
          <div class="pit-stop-stat">
            <span class="pit-stop-stat-val">${d.avg_s}s</span>
            <span class="pit-stop-stat-lbl">Average</span>
          </div>
          <div class="pit-stop-stat">
            <span class="pit-stop-stat-val">${d.count}</span>
            <span class="pit-stop-stat-lbl">Stops</span>
          </div>
        </div>
        <div class="pit-stop-history">${historyRows}</div>
      </div>`;
  } catch(_) {}
}

// Inject delta and stopwatch panels into the live tab on first render
function ensureLivePanels() {
  if ($('#fuelDeltaPanel')) return;
  const liveStatus = $('#liveStatus');
  if (!liveStatus) return;

  const deltaEl = document.createElement('div');
  deltaEl.id = 'fuelDeltaPanel';
  liveStatus.before(deltaEl);

  const pitEl = document.createElement('div');
  pitEl.id = 'pitStopPanel';
  liveStatus.before(pitEl);
}

// Full pollTelemetry replacement — handles delta, stopwatch, session import
async function pollTelemetry() {
  if (!state.activePlan) return;
  try {
    const res = await fetch(`/api/plans/${state.activePlan.id}/telemetry`);
    if (!res.ok) return;
    const t = await res.json();

    const live  = !t.stale && t.current_lap > 0;
    const dot   = $('#telemetryDot');
    const label = $('#telemetryLabel');
    if (dot)   dot.className    = 'telemetry-dot' + (live ? ' live' : '');
    if (label) label.textContent = live ? '● LIVE' : '○ Telemetry: offline';
    if (label) label.className  = 'telemetry-label' + (live ? ' live' : '');

    if (live && t.current_lap) {
      const lapInput = $('#currentLap');
      if (lapInput && parseInt(lapInput.value) !== t.current_lap) {
        lapInput.value = t.current_lap;
        updateLiveStatus();
      }
    }

    // Fuel delta panel
    if (t.fuel_delta && state.activePlan) {
      ensureLivePanels();
      const plannedFpl = state.activePlan.config?.fuel_per_lap || 1.0;
      renderFuelDelta(t.fuel_delta, plannedFpl);
    }

    // Pit stop stopwatch
    ensureLivePanels();
    loadPitStopPanel();

    // Session auto-import banner
    if (t.session_info && !state.sessionImportDismissed) {
      const si = t.session_info;
      let banner = $('#sessionImportBanner');
      if (!banner) {
        banner = document.createElement('div');
        banner.id = 'sessionImportBanner';
        banner.className = 'session-import-banner';
        banner.innerHTML = `
          <span class="si-text">iRacing: <strong>${si.track_name || '?'}</strong> — ${si.series_name || '?'}</span>
          <button class="si-import-btn btn-sm" id="siImportBtn">Import</button>
          <button class="si-dismiss-btn btn-ghost btn-sm" id="siDismissBtn">✕</button>`;
        const liveSection = $('#tab-live');
        if (liveSection) liveSection.prepend(banner);
        $('#siImportBtn')?.addEventListener('click', () => {
          const trackInput = $('#trackName');
          if (trackInput) trackInput.value = si.track_name || '';
          state.sessionImportDismissed = true;
          banner.remove();
        });
        $('#siDismissBtn')?.addEventListener('click', () => {
          state.sessionImportDismissed = true;
          banner.remove();
        });
      }
    }
  } catch(_) {}
}

// =============================================================================
// PRINT STRATEGY SHEET
// =============================================================================
async function triggerPrint() {
  if (!state.activePlan) { alert('Load a plan first.'); return; }
  const plan   = state.activePlan;
  const config = plan.config || {};
  const stints = plan.stints || [];

  // Populate print sheet
  $('#printTitle').textContent    = plan.name || 'RACE STRATEGY';
  $('#printSubtitle').textContent = `${config.race_duration_hrs || '?'}h | ${config.track_name || ''} | Lap time ${config.lap_time_s ? secToMinSec(config.lap_time_s) : '?'}`;
  $('#printDate').textContent     = new Date().toLocaleString();
  $('#printFooterPlan').textContent = `Plan ID: ${plan.id}`;

  $('#printParams').innerHTML = [
    { v: `${config.race_duration_hrs || '?'}h`, l: 'Duration' },
    { v: secToMinSec(config.lap_time_s || 90), l: 'Lap time' },
    { v: `${config.fuel_capacity_l || '?'}L`, l: 'Tank' },
    { v: `${config.fuel_per_lap || '?'}L`, l: 'Fuel/lap' },
    { v: `${config.pit_loss_s || '?'}s`, l: 'Pit loss' },
    { v: stints.length,  l: 'Total stops' },
    { v: plan.drivers?.length || '?', l: 'Drivers' },
    { v: config.fuel_mode || 'normal', l: 'Mode' },
  ].map(p => `<div class="print-param-cell"><strong>${p.v}</strong><span>${p.l}</span></div>`).join('');

  $('#printStintBody').innerHTML = stints.map(s => `
    <tr>
      <td>${s.stint_num}</td>
      <td><span class="print-driver-dot" style="background:${s.driver_color||'#C49A3C'}"></span>${s.driver_name || '—'}</td>
      <td>${s.start_lap}–${s.end_lap} (${s.end_lap - s.start_lap + 1} laps)</td>
      <td>${s.pit_lap || '—'}</td>
      <td>${s.fuel_load}L</td>
      <td>${s.fuel_mode}</td>
      <td>${s.tire_compound || '—'}</td>
    </tr>`).join('');

  // Contingencies
  try {
    const cr  = await fetch(`/api/plans/${plan.id}/contingencies`);
    const ctg = cr.ok ? await cr.json() : null;
    if (ctg) {
      $('#printContingencies').innerHTML = ['main','save_mode','short_fill'].map(k => {
        const c = ctg[k]; if (!c) return '';
        return `<div class="print-contingency-item">
          <div class="print-contingency-name">${c.label}</div>
          <div>${c.total_stops} stops — ~${c.avg_fuel_per_stop}L/stop</div>
          <div style="font-size:0.75rem;color:#888">${c.note || ''}</div>
        </div>`;
      }).join('');
      $('#printContingencySection').style.display = '';
    }
  } catch(_) { $('#printContingencySection').style.display = 'none'; }

  window.print();
}
