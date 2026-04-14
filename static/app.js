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
      if (tab === 'stint'  && state.activePlan) renderStintTable(state.activePlan);
      if (tab === 'live'   && state.activePlan) renderLiveMode(state.activePlan);
      if (tab === 'export' && state.activePlan) renderExport(state.activePlan);
    });
  });
}

// ---------------------------------------------------------------------------
// Plan selector (header dropdown)
// ---------------------------------------------------------------------------
async function loadPlanList() {
  const res   = await fetch('/api/plans');
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
}

async function loadPlan(id) {
  const res  = await fetch(`/api/plans/${id}`);
  if (!res.ok) return;
  const plan = await res.json();
  state.activePlan = plan;
  populateSetupForm(plan);
  renderStintTable(plan);
  renderLiveMode(plan);
  renderExport(plan);
  $('#planSelect').value = id;
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
  $('#fuelCapacity').value  = c.fuel_capacity_l || 70;
  $('#fuelPerLap').value    = c.fuel_per_lap_l || 3.5;

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
    fuel_capacity_l:    parseFloat($('#fuelCapacity').value)  || 70,
    fuel_per_lap_l:     parseFloat($('#fuelPerLap').value)    || 3.5,
    fuel_mode:          state.fuelMode,
  };
}

function buildDrivers() {
  return $$('.driver-row').map((row, i) => ({
    name:      $('.driver-name', row).value.trim() || `Driver ${i + 1}`,
    max_hours: parseFloat($('.driver-maxhrs', row).value) || 2.5,
    color:     $('.driver-color', row).value,
  }));
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
    $('.driver-color', row).value   = driver.color  || COLORS[idx % COLORS.length];
    $('.driver-name',  row).value   = driver.name   || '';
    $('.driver-maxhrs',row).value   = driver.max_hours || 2.5;
  } else {
    $('.driver-color', row).value   = COLORS[idx % COLORS.length];
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
  const cap    = parseFloat($('#fuelCapacity').value) || 70;
  const fpl    = parseFloat($('#fuelPerLap').value)   || 3.5;
  const mult   = MODE_MULT[state.fuelMode] || 1;
  const effFpl = fpl * mult;
  const usable = cap - effFpl;                        // 1-lap safety buffer
  const laps   = Math.floor(usable / effFpl);
  const lapSec = getLapTimeSec() || 90;
  const stintSec = laps * lapSec;

  $('#previewLaps').textContent       = laps > 0 ? laps : '—';
  $('#previewStintTime').textContent  = laps > 0 ? hrsToHM(stintSec / 3600) : '—';
  $('#previewFpl').textContent        = `${fmt(effFpl, 3)} L`;
}

// ---------------------------------------------------------------------------
// Calculate / Save
// ---------------------------------------------------------------------------
async function calculateStrategy() {
  const config  = buildConfig();
  const drivers = buildDrivers();
  const name    = $('#planName').value.trim() || 'Untitled Plan';
  const msg     = $('#setupMessages');

  let res, plan;
  if (state.activePlan) {
    res  = await fetch(`/api/plans/${state.activePlan.id}`, {
      method:  'PUT',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ name, config, drivers }),
    });
    plan = await res.json();
  } else {
    res  = await fetch('/api/plans', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ name, config, drivers }),
    });
    const data = await res.json();
    // after create, fetch full plan
    const res2 = await fetch(`/api/plans/${data.id}`);
    plan = await res2.json();
  }

  if (!res.ok) {
    showMessage(msg, 'Error calculating strategy.', 'error');
    return;
  }

  state.activePlan = plan;
  await loadPlanList();
  showMessage(msg, 'Strategy calculated. Switch to Stint Plan to review.');
  renderStintTable(plan);

  // auto-switch to stint tab
  $$('.tab-btn').forEach(b => b.classList.remove('active'));
  $$('.tab-section').forEach(s => s.classList.remove('active'));
  $('[data-tab="stint"]').classList.add('active');
  $('#tab-stint').classList.add('active');
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
    showMessage(msg, 'Save failed.', 'error');
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

  const config     = plan.config || {};
  const fuelCap    = config.fuel_capacity_l || 70;
  const lapTimeSec = config.lap_time_s || 90;
  const totalLaps  = stints[stints.length - 1]?.end_lap || 1;

  // meta badges
  const fpl         = config.fuel_per_lap_l * (MODE_MULT[config.fuel_mode] || 1);
  const lapsPerTank = Math.floor((fuelCap - fpl) / fpl);
  const pitStops    = stints.filter(s => s.pit_lap).length;

  $('#strategyMeta').innerHTML = `
    <span class="badge">Total laps: <strong>${totalLaps}</strong></span>
    <span class="badge">Stints: <strong>${stints.length}</strong></span>
    <span class="badge">Pit stops: <strong>${pitStops}</strong></span>
    <span class="badge">Laps/tank: <strong>${lapsPerTank}</strong></span>
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
          <th>Start Lap</th>
          <th>End Lap</th>
          <th>Laps</th>
          <th>Stint Time</th>
          <th>Pit Lap</th>
          <th>Fuel Load</th>
          <th>Fuel %</th>
        </tr>
      </thead>
      <tbody>
  `;

  stints.forEach(s => {
    const laps      = s.end_lap - s.start_lap + 1;
    const stintSec  = laps * lapTimeSec;
    const fuelPct   = Math.min(Math.round((s.fuel_load / fuelCap) * 100), 100);
    const isLast    = !s.pit_lap;
    const dotColor  = s.driver_color || '#4fc3f7';
    const pitCell   = isLast
      ? '<span class="no-pit-badge">FINISH</span>'
      : `<span class="pit-badge">Lap ${s.pit_lap}</span>`;

    const cmpSel  = tireSelectHtml(s.id, s.tire_compound || '');
    const ageVal  = s.tire_age_laps != null ? s.tire_age_laps : '';
    const setVal  = s.tire_set || '';

    html += `
      <tr class="${isLast ? 'last-stint' : ''}">
        <td>${s.stint_num}</td>
        <td>
          <span class="driver-dot" style="background:${dotColor}"></span>
          ${s.driver_name || '—'}
        </td>
        <td class="tire-cell">
          <div class="tire-inputs">
            ${cmpSel}
            <input type="text"   class="tire-set-inp" data-stint-id="${s.id}" value="${setVal}"  placeholder="Set#" maxlength="6" title="Set number" />
            <input type="number" class="tire-age-inp" data-stint-id="${s.id}" value="${ageVal}" placeholder="Age"  min="0" max="999" title="Laps already on tires" />
          </div>
        </td>
        <td>${s.start_lap}</td>
        <td>${s.end_lap}</td>
        <td>${laps}</td>
        <td>${hrsToHM(stintSec / 3600)}</td>
        <td>${pitCell}</td>
        <td>${fmt(s.fuel_load, 1)} L</td>
        <td class="fuel-bar-cell">
          <div class="fuel-bar">
            <div class="fuel-bar-fill" style="width:${fuelPct}%"></div>
          </div>
          <span style="font-size:0.7rem;color:var(--text-dim)">${fuelPct}%</span>
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
  const existing = {
    cmp: nextStint.tire_compound || '',
    set: nextStint.tire_set      || '',
    age: nextStint.tire_age_laps != null ? nextStint.tire_age_laps : '',
  };

  const promptEl = document.createElement('div');
  promptEl.className = 'tire-prompt';
  promptEl.innerHTML = `
    <span class="tp-label">Next tires (Stint #${nextStint.stint_num}):</span>
    <select class="tp-cmp">
      <option value="">—</option>
      ${TIRE_OPTS}
    </select>
    <input type="text"   class="tp-set" value="${existing.set}" placeholder="Set#" maxlength="6" />
    <input type="number" class="tp-age" value="${existing.age}" placeholder="Age"  min="0" max="999" />
    <button class="tp-confirm btn-primary">✓ Confirm</button>
    <button class="tp-skip btn-ghost">Skip</button>
  `;

  btn.replaceWith(promptEl);

  // pre-select existing compound
  promptEl.querySelector('.tp-cmp').value = existing.cmp;

  async function finish(saveTires) {
    if (saveTires) {
      const cmp = promptEl.querySelector('.tp-cmp').value;
      const set = promptEl.querySelector('.tp-set').value.trim();
      const age = promptEl.querySelector('.tp-age').value;
      await saveTireData(planId, nextStint.id, {
        tire_compound: cmp  || null,
        tire_set:      set  || null,
        tire_age_laps: age !== '' ? parseInt(age) : null,
      });
    }
    await completStintNow(planId, currentStintId);
  }

  promptEl.querySelector('.tp-confirm').addEventListener('click', () => finish(true));
  promptEl.querySelector('.tp-skip').addEventListener('click',    () => finish(false));
}

async function updateLiveStatus() {
  if (!state.activePlan) return;
  const lap = parseInt($('#currentLap').value) || 1;
  const res = await fetch(`/api/plans/${state.activePlan.id}/live_status?lap=${lap}`);
  if (!res.ok) return;
  const data = await res.json();

  const statusEl = $('#liveStatus');
  if (data.status === 'finished') {
    statusEl.innerHTML = '<div class="live-status-block"><p style="color:var(--green);text-align:center;font-weight:700;">RACE COMPLETE</p></div>';
    return;
  }

  const s        = data.current_stint;
  const next     = data.next_stint;
  const laps2pit = data.laps_until_pit;
  const alertClass = laps2pit <= 1 ? 'alert-critical' : laps2pit <= 3 ? 'alert-pit' : '';

  // highlight current stint in list
  $$('.live-stint-item').forEach(item => {
    const start = parseInt(item.dataset.startLap);
    const end   = parseInt(item.dataset.endLap);
    item.classList.toggle('is-current', lap >= start && lap <= end);
  });

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
      ${next ? `
      <div class="live-stat-row">
        <span class="live-stat-label">Next driver</span>
        <span class="live-stat-val"><span class="driver-dot" style="background:${next.driver_color||'#4fc3f7'}"></span>${next.driver_name || '—'}</span>
      </div>
      ` : ''}
    </div>
    ${laps2pit <= 3 && laps2pit > 0 ? `<div class="pit-alert-banner">⚑ PIT IN ${laps2pit} LAP${laps2pit === 1 ? '' : 'S'}</div>` : ''}
    ${laps2pit <= 0 && s.pit_lap ? `<div class="pit-alert-banner" style="background:var(--red);color:#fff">PIT THIS LAP</div>` : ''}
  `;
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

  const c          = plan.config || {};
  const stints     = plan.stints || [];
  const fuelCap    = c.fuel_capacity_l || 70;
  const lapTimeSec = c.lap_time_s || 90;
  const fpl        = (c.fuel_per_lap_l || 3.5) * (MODE_MULT[c.fuel_mode] || 1);
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
      <div class="export-meta-cell"><span class="val">${fmt(fpl, 3)}L</span><span class="lbl">Fuel/Lap</span></div>
      <div class="export-meta-cell"><span class="val">${fuelCap}L</span><span class="lbl">Tank Capacity</span></div>
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
          <th>#</th><th>Driver</th><th>Tires</th><th>Start Lap</th><th>End Lap</th>
          <th>Laps</th><th>Stint Time</th><th>Pit Lap</th><th>Fuel Load</th>
        </tr>
      </thead>
      <tbody>
        ${stints.map(s => {
          const laps     = s.end_lap - s.start_lap + 1;
          const stintSec = laps * lapTimeSec;
          const isLast   = !s.pit_lap;
          const tireStr  = s.tire_compound
            ? `${TIRE_LABELS[s.tire_compound] || s.tire_compound}${s.tire_set ? ' / ' + s.tire_set : ''}${s.tire_age_laps != null ? ' (' + s.tire_age_laps + ' laps)' : ''}`
            : '—';
          return `
            <tr>
              <td>${s.stint_num}</td>
              <td><span class="driver-dot" style="background:${s.driver_color||'#4fc3f7'}"></span>${s.driver_name||'—'}</td>
              <td>${tireStr}</td>
              <td>${s.start_lap}</td>
              <td>${s.end_lap}</td>
              <td>${laps}</td>
              <td>${hrsToHM(stintSec/3600)}</td>
              <td>${isLast ? '— FINISH —' : `Lap ${s.pit_lap}`}</td>
              <td>${fmt(s.fuel_load,1)} L</td>
            </tr>
          `;
        }).join('')}
      </tbody>
    </table>
  `;

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
  await loadPlanList();

  // auto-load the most recent plan if any
  const sel = $('#planSelect');
  if (sel.options.length > 1) {
    sel.selectedIndex = 1;
    await loadPlan(sel.value);
  }
}

document.addEventListener('DOMContentLoaded', boot);
