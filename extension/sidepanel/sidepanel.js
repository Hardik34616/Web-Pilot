// WebPilot AI — side panel controller and agent loop.

import { PROFILE_FIELDS, FIELD_KEYS, effectiveProfile, IMPORT_PROMPT, parseImport } from './profile.js';
import { planWithAI, planHeuristic, testAI } from './planner.js';
import { PROVIDERS, providerOf, activeKey, activeModel } from './providers.js';
import { classify, needsApproval } from './safety.js';
import { store } from './storage.js';

const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const MAX_ROUNDS = 8;

let settings, profile, askKeys, workflows, history;
let running = false, stopRequested = false, pendingApproval = null, lastModelNotice = null;

// ======================================================================
// Init
// ======================================================================
async function init() {
  [settings, profile, askKeys, workflows, history] = await Promise.all(
    ['settings', 'profile', 'askKeys', 'workflows', 'history'].map((k) => store.get(k)));

  // tabs
  $$('.tab').forEach((t) => t.addEventListener('click', () => showTab(t.dataset.tab)));

  // mode
  setMode(settings.mode);
  $$('input[name="mode"]').forEach((r) => r.addEventListener('change', () => { settings.mode = currentMode(); store.set('settings', settings); }));

  // composer
  const task = $('#task');
  task.addEventListener('input', autoGrow);
  task.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submitTask(); }
  });
  $('#run').addEventListener('click', submitTask);
  $('#stop').addEventListener('click', requestStop);
  $$('.chip').forEach((c) => c.addEventListener('click', () => { task.value = c.textContent; autoGrow(); task.focus(); }));
  $('#saveWf').addEventListener('click', saveWorkflow);
  $('#clearLog').addEventListener('click', () => { if (!running) $('#log').innerHTML = ''; });

  // profile
  renderProfileForm();
  $('#saveProfile').addEventListener('click', saveProfile);
  $('#clearProfile').addEventListener('click', clearProfile);
  $('#copyPrompt').addEventListener('click', copyImportPrompt);
  $('#previewImport').addEventListener('click', previewImport);

  // settings
  renderSettings();
  $('#provider').addEventListener('change', onProviderChange);
  $('#saveSettings').addEventListener('click', saveSettings);
  $('#testKey').addEventListener('click', testKey);

  // workflows / history
  $('#clearHistory').addEventListener('click', async () => { history = []; await store.set('history', history); renderHistory(); });
  renderWorkflows();
  renderHistory();
  updateStatus();
}

function showTab(name) {
  $$('.tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === name));
  $$('.panel').forEach((p) => p.classList.toggle('active', p.id === 'tab-' + name));
}
function currentMode() { return $('input[name="mode"]:checked')?.value || 'review'; }
function setMode(m) { const r = $(`input[name="mode"][value="${m}"]`); if (r) r.checked = true; }
function autoGrow() { const t = $('#task'); t.style.height = 'auto'; t.style.height = Math.min(t.scrollHeight, 140) + 'px'; }
function flash(sel, text) { const el = $(sel); el.textContent = text; setTimeout(() => { el.textContent = ''; }, 2200); }

function updateStatus(busyText) {
  const s = $('#status');
  s.classList.toggle('ai', !!activeKey(settings));
  s.classList.toggle('busy', !!busyText);
  $('#statusText').textContent = busyText || (activeKey(settings) ? `${PROVIDERS[providerOf(settings)].name.split(' ')[0]} · ${lastModelNotice || activeModel(settings)}` : 'Offline matcher');
}

// ======================================================================
// Chat log rendering
// ======================================================================
function logEl() { $('#welcome')?.remove(); return $('#log'); }
function scrollLog() { const l = $('#log'); l.scrollTop = l.scrollHeight; }

function addMsg(role, text) {
  const d = document.createElement('div');
  d.className = 'msg ' + role;
  d.textContent = text;
  logEl().appendChild(d);
  scrollLog();
  return d;
}

const ICONS = { pending: '○', running: '<span class="spin"></span>', done: '✅', skipped: '⏭️', failed: '❌', waiting: '⏸️' };

function addPlanCard(title, actions) {
  const card = document.createElement('div');
  card.className = 'plan';
  card.innerHTML = `<div class="plan-head"><span>${esc(title)}</span><span class="count">0/${actions.length}</span></div><ol></ol>`;
  const ol = card.querySelector('ol');
  const items = actions.map((a) => {
    const li = document.createElement('li');
    li.className = 'pending';
    li.innerHTML = `<span class="ic">${ICONS.pending}</span><div><div class="t">${esc(a.description)}</div><div class="d"></div></div>`;
    ol.appendChild(li);
    return li;
  });
  logEl().appendChild(card);
  scrollLog();
  let done = 0;
  return {
    set(i, status, detail) {
      const li = items[i];
      if (!li) return;
      if (status === 'done' && !li.classList.contains('done')) card.querySelector('.count').textContent = `${++done}/${actions.length}`;
      li.className = status;
      li.querySelector('.ic').innerHTML = ICONS[status] || '';
      li.querySelector('.d').textContent = detail || '';
      if (status === 'running' || status === 'waiting') li.scrollIntoView({ block: 'nearest' });
    },
  };
}

function askApproval({ action, el, value, risk, mode }) {
  return new Promise((resolve) => {
    const card = document.createElement('div');
    card.className = 'approval' + (risk.level === 'sensitive' ? ' sensitive' : '');
    const showVal = value != null && value !== '' && action.type !== 'click';
    card.innerHTML = `
      <div class="ttl">${risk.level === 'sensitive' ? '⚠️ Approval needed' : '✋ Review this step'}</div>
      <div>${esc(action.description)}</div>
      ${showVal ? `<div style="margin-top:4px">Value: <span class="val">${esc(value)}</span></div>` : ''}
      <div class="meta">${esc(el?.label ? `Element: “${el.label}”` : '')}${risk.reason ? ' · ' + esc(risk.reason) : ''}</div>
      <div class="btns">
        <button class="ok" data-d="approve">Approve</button>
        ${mode === 'step' && risk.level !== 'sensitive' ? '<button class="small" data-d="all">Approve rest of step</button>' : ''}
        <button class="small" data-d="skip">Skip</button>
        <button class="small" data-d="stop">Stop task</button>
      </div>`;
    logEl().appendChild(card);
    scrollLog();
    const finish = (d) => {
      card.classList.add('answered');
      card.querySelector('.ttl').textContent += ` — ${{ approve: 'approved', all: 'approved', skip: 'skipped', stop: 'stopped' }[d]}`;
      pendingApproval = null;
      updateStatus('Working…');
      resolve(d);
    };
    card.querySelectorAll('button').forEach((b) => b.addEventListener('click', () => finish(b.dataset.d)));
    pendingApproval = finish;
    updateStatus('Waiting for you');
    card.querySelector('button.ok').focus();
  });
}

function addSummary({ status, counts, missing, sensitiveSkipped }) {
  const d = document.createElement('div');
  const cls = status === 'completed' ? '' : status === 'error' ? 'bad' : 'warn';
  d.className = 'summary ' + cls;
  const title = {
    completed: '✅ Task complete',
    stopped: '⏹️ Task stopped',
    'needs-help': '🙋 I need your help',
    error: '❌ Something went wrong',
  }[status];
  let body = '';
  if (status === 'completed') {
    body = sensitiveSkipped
      ? 'Everything is filled in. I did not submit — review the page and submit when you are ready.'
      : 'Please review the page to make sure everything looks right.';
  }
  if (missing.length) body += `${body ? '\n' : ''}I had no data for: ${missing.join(', ')}. Add them to your Profile or fill them in yourself.`;
  d.innerHTML = `<h4>${title}</h4>
    <div class="stats"><span>✅ ${counts.done} done</span><span>⏭️ ${counts.skipped} skipped</span><span>❌ ${counts.failed} failed</span></div>
    <div style="white-space:pre-wrap">${esc(body)}</div>`;
  logEl().appendChild(d);
  scrollLog();
}

// ======================================================================
// Talking to the page
// ======================================================================
async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

async function inject(tabId) {
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: ['content/content.js'] });
  } catch (e) {
    const t = await chrome.tabs.get(tabId);
    if ((t.url || '').startsWith('file:')) {
      throw new Error('Chrome blocks extensions on local files by default. Open chrome://extensions → WebPilot AI → Details → enable “Allow access to file URLs”, or serve the page over http.');
    }
    throw new Error(`I can't access this page (${e.message}). Chrome doesn't allow extensions on some pages such as the Web Store or chrome:// pages.`);
  }
}

async function send(tabId, msg) {
  const r = await chrome.tabs.sendMessage(tabId, msg);
  if (!r) throw new Error('The page did not respond.');
  if (!r.ok) throw new Error(r.error);
  return r.data;
}

async function settle(tabId) {
  await sleep(700);
  for (let i = 0; i < 60; i++) {
    const t = await chrome.tabs.get(tabId);
    if (t.status === 'complete') break;
    await sleep(250);
  }
  await sleep(300);
}

const signature = (snap) => JSON.stringify([snap.url, snap.headings, snap.elements.map((e) => [e.label, e.kind, e.value, e.checked])]);

function resolveValue(a, prof) {
  if (a.type === 'navigate') return a.url;
  if (a.type !== 'fill' && a.type !== 'select') return undefined;
  if (a.profileKey && prof[a.profileKey]) return prof[a.profileKey];
  return a.value;
}

function describeDone(a, el) {
  const label = el?.label ? `“${el.label}”` : '';
  switch (a.type) {
    case 'fill': return `filled ${label} ${a.profileKey ? `with profile.${a.profileKey}` : `with "${a.value}"`}`;
    case 'select': return `selected ${a.profileKey ? `profile.${a.profileKey}` : `"${a.value}"`} in ${label}`;
    case 'check': return `checked ${label}`;
    case 'uncheck': return `unchecked ${label}`;
    case 'click': return `clicked ${label}`;
    case 'navigate': return `navigated to ${a.url}`;
    default: return a.type;
  }
}

// ======================================================================
// Agent loop
// ======================================================================
function submitTask() {
  const text = $('#task').value.trim();
  if (!text || running) return;
  $('#task').value = '';
  autoGrow();
  runTask(text, currentMode());
}

function requestStop() {
  stopRequested = true;
  if (pendingApproval) pendingApproval('stop');
  addMsg('system', 'Stopping after the current action…');
}

function setRunning(on) {
  running = on;
  $('#run').hidden = on;
  $('#stop').hidden = !on;
  $('#task').disabled = on;
  updateStatus(on ? 'Working…' : null);
}

async function runTask(instruction, mode) {
  addMsg('user', instruction);
  const tab = await getActiveTab();
  if (!tab || !/^(https?|file):/i.test(tab.url || '')) {
    addMsg('assistant', 'I can only work on regular web pages. Open a website (or the demo form) in this window and try again.');
    return;
  }

  setRunning(true);
  stopRequested = false;
  const modeName = { full: 'Full Auto', review: 'Review', step: 'Step-by-step' }[mode];
  addMsg('system', `Mode: ${modeName} · ${activeKey(settings) ? `${PROVIDERS[providerOf(settings)].name.split(' ')[0]} planner` : 'offline matcher (add a free API key in Settings for smarter plans)'}`);

  const prof = effectiveProfile(profile);
  const completed = [];
  const missing = new Set();
  const counts = { done: 0, skipped: 0, failed: 0 };
  let status = 'completed', lastSig = null, sensitiveSkipped = false;

  try {
    for (let round = 1; round <= MAX_ROUNDS; round++) {
      if (stopRequested) { status = 'stopped'; break; }
      await inject(tab.id);
      const snap = await send(tab.id, { cmd: 'snapshot' });
      const byId = Object.fromEntries(snap.elements.map((e) => [e.id, e]));
      const sig = signature(snap);
      if (lastSig && sig === lastSig) {
        addMsg('assistant', "The page didn't change after my last click, so I stopped to avoid repeating myself. Please check the page for errors.");
        status = 'needs-help';
        break;
      }
      lastSig = sig;
      addMsg('system', `Analyzing “${snap.headings[0] || snap.title || snap.url}” · ${snap.elements.length} interactive elements`);

      let plan;
      if (activeKey(settings)) {
        updateStatus('Planning…');
        try {
          plan = await planWithAI({
            instruction, snapshot: snap, profile: prof, completed, settings,
            onNotice: (text) => addMsg('system', text),
          });
          if (plan.model !== activeModel(settings) && plan.model !== lastModelNotice) {
            addMsg('system', `Planning with ${plan.model} (${activeModel(settings)} is busy right now).`);
          }
          lastModelNotice = plan.model;
        } catch (e) {
          addMsg('system', `AI planner unavailable (${e.message}). Using the offline matcher instead.`);
          plan = planHeuristic({ instruction, snapshot: snap, profile: prof });
        }
        updateStatus('Working…');
      } else {
        plan = planHeuristic({ instruction, snapshot: snap, profile: prof });
      }

      plan.missing.forEach((m) => missing.add(m));
      if (plan.message) addMsg('assistant', plan.message);
      if (!plan.actions.length) break;

      const card = addPlanCard(`Plan · page ${round}`, plan.actions);
      let pageChanged = false, approveRest = false;

      for (let i = 0; i < plan.actions.length; i++) {
        if (stopRequested) { status = 'stopped'; break; }
        const a = plan.actions[i];
        const el = byId[a.target];
        const value = resolveValue(a, prof);

        if ((a.type === 'fill' || a.type === 'select') && (value == null || value === '')) {
          card.set(i, 'skipped', 'no value in your profile');
          missing.add(el?.label || a.profileKey);
          counts.skipped++;
          continue;
        }
        const risk = classify(a, el, askKeys);
        if (risk.level === 'blocked') { card.set(i, 'skipped', risk.reason); counts.skipped++; continue; }

        if (needsApproval(mode, risk.level) && !(approveRest && risk.level !== 'sensitive')) {
          card.set(i, 'waiting', 'waiting for your approval');
          const d = await askApproval({ action: a, el, value, risk, mode });
          if (d === 'stop') { card.set(i, 'skipped', 'stopped by you'); stopRequested = true; status = 'stopped'; break; }
          if (d === 'skip') {
            card.set(i, 'skipped', 'skipped by you');
            counts.skipped++;
            if (risk.level === 'sensitive' && a.type === 'click') sensitiveSkipped = true;
            continue;
          }
          if (d === 'all') approveRest = true;
        }

        card.set(i, 'running');
        try {
          let res;
          if (a.type === 'navigate') {
            await chrome.tabs.update(tab.id, { url: a.url });
            res = { detail: 'opened page' };
          } else {
            res = await send(tab.id, { cmd: 'execute', action: a, value });
          }
          card.set(i, 'done', res?.detail);
          counts.done++;
          completed.push(describeDone(a, el));
        } catch (e) {
          card.set(i, 'failed', e.message);
          counts.failed++;
          addMsg('assistant', `I couldn't complete “${a.description}”: ${e.message}\nI've stopped safely. Fix it on the page or adjust your instruction, then run me again.`);
          status = 'needs-help';
          stopRequested = true;
          break;
        }

        if (a.type === 'click' || a.type === 'navigate') {
          await settle(tab.id);
          pageChanged = true;
          for (let j = i + 1; j < plan.actions.length; j++) card.set(j, 'skipped', 'page changed — re-planning');
          break;
        }
        await sleep(mode === 'full' ? 120 : 200);
      }

      if (stopRequested || !pageChanged || plan.done) break;
      if (round === MAX_ROUNDS) addMsg('system', `Reached the ${MAX_ROUNDS}-page safety limit.`);
    }
    // In "prepare for submission" flows, the submit button is intentionally left for the user.
    if (status === 'completed' && !sensitiveSkipped) sensitiveSkipped = !completed.some((c) => /clicked .*(submit|register|apply|pay)/i.test(c));
  } catch (e) {
    status = 'error';
    addMsg('error', e.message);
  }

  if (stopRequested && status === 'completed') status = 'stopped';
  addSummary({ status, counts, missing: [...missing].filter(Boolean), sensitiveSkipped });
  setRunning(false);
  stopRequested = false;

  history.unshift({ time: Date.now(), url: tab.url, title: tab.title, instruction, mode, status, counts });
  history = history.slice(0, 30);
  await store.set('history', history);
  renderHistory();
}

// ======================================================================
// Profile vault
// ======================================================================
function renderProfileForm() {
  const form = $('#profileForm');
  form.innerHTML = '';
  let group = '';
  for (const f of PROFILE_FIELDS) {
    if (f.group !== group) {
      group = f.group;
      form.insertAdjacentHTML('beforeend', `<div class="group-title">${esc(group)}</div>`);
    }
    const input = f.multiline
      ? `<textarea name="${f.key}" rows="2"></textarea>`
      : `<input name="${f.key}" type="${f.type === 'date' ? 'date' : 'text'}" autocomplete="off" />`;
    form.insertAdjacentHTML('beforeend', `
      <div class="pfield">
        <label class="field"><span>${esc(f.label)}</span>${input}</label>
        <label class="lock" title="Ask before using this field"><input type="checkbox" data-ask="${f.key}" />🔒</label>
      </div>`);
  }
  fillProfileForm();
  form.addEventListener('submit', (e) => e.preventDefault());
}

function fillProfileForm() {
  for (const f of PROFILE_FIELDS) {
    $(`#profileForm [name="${f.key}"]`).value = profile[f.key] || '';
    $(`#profileForm [data-ask="${f.key}"]`).checked = askKeys.includes(f.key);
  }
  $('#customFields').value = Object.entries(profile.custom || {}).map(([k, v]) => `${k}: ${v}`).join('\n');
}

function readProfileForm() {
  const p = {};
  for (const f of PROFILE_FIELDS) {
    const v = $(`#profileForm [name="${f.key}"]`).value.trim();
    if (v) p[f.key] = v;
  }
  const custom = {};
  for (const line of $('#customFields').value.split('\n')) {
    const i = line.indexOf(':');
    if (i > 0) {
      const k = line.slice(0, i).trim(), v = line.slice(i + 1).trim();
      if (k && v) custom[k] = v;
    }
  }
  if (Object.keys(custom).length) p.custom = custom;
  return p;
}

async function saveProfile() {
  profile = readProfileForm();
  askKeys = $$('#profileForm [data-ask]').filter((c) => c.checked).map((c) => c.dataset.ask);
  await Promise.all([store.set('profile', profile), store.set('askKeys', askKeys)]);
  flash('#profileSaved', '✓ Saved');
}

async function clearProfile() {
  if (!confirm('Clear all saved profile data from this device?')) return;
  profile = {};
  await store.set('profile', profile);
  fillProfileForm();
  flash('#profileSaved', 'Cleared');
}

async function copyImportPrompt() {
  await navigator.clipboard.writeText(IMPORT_PROMPT);
  const b = $('#copyPrompt');
  b.textContent = '✓ Copied';
  setTimeout(() => { b.textContent = 'Copy prompt'; }, 1800);
}

function previewImport() {
  const box = $('#importPreview');
  let data;
  try {
    data = parseImport($('#importText').value);
  } catch (e) {
    box.innerHTML = `<p class="hint" style="color:var(--danger)">${esc(e.message)}</p>`;
    return;
  }
  const current = { ...(profile.custom || {}), ...profile };
  const rows = Object.entries(data);
  if (!rows.length) { box.innerHTML = '<p class="hint">Nothing to import — all values were empty.</p>'; return; }
  const labelOf = (k) => PROFILE_FIELDS.find((f) => f.key === k)?.label || `${k} (custom)`;
  box.innerHTML = `
    <table class="preview">
      <tr><th></th><th>Field</th><th>Current</th><th>New</th></tr>
      ${rows.map(([k, v]) => `<tr>
        <td><input type="checkbox" data-k="${esc(k)}" ${current[k] === v ? '' : 'checked'} style="width:auto"></td>
        <td>${esc(labelOf(k))}</td><td class="old">${esc(current[k] || '—')}</td><td class="new">${esc(v)}</td></tr>`).join('')}
    </table>
    <div class="row"><button class="primary" id="doImport">Import selected</button><button class="ghost" id="cancelImport">Cancel</button></div>`;
  $('#cancelImport').onclick = () => { box.innerHTML = ''; };
  $('#doImport').onclick = async () => {
    const picked = $$('#importPreview input[data-k]').filter((c) => c.checked).map((c) => c.dataset.k);
    const custom = { ...(profile.custom || {}) };
    for (const k of picked) {
      if (FIELD_KEYS.includes(k)) profile[k] = data[k];
      else custom[k] = data[k];
    }
    if (Object.keys(custom).length) profile.custom = custom;
    await store.set('profile', profile);
    fillProfileForm();
    box.innerHTML = `<p class="saved">✓ Imported ${picked.length} field${picked.length === 1 ? '' : 's'}. Review them below.</p>`;
    $('#importText').value = '';
  };
}

// ======================================================================
// Workflows & history
// ======================================================================
async function saveWorkflow() {
  const instruction = $('#task').value.trim() || history[0]?.instruction;
  if (!instruction) { addMsg('system', 'Type a task (or run one) first, then save it as a workflow.'); return; }
  workflows.unshift({ id: crypto.randomUUID(), name: instruction.slice(0, 70), instruction, mode: currentMode(), created: Date.now() });
  await store.set('workflows', workflows);
  renderWorkflows();
  addMsg('system', '☆ Saved to Workflows');
}

function renderWorkflows() {
  const list = $('#wfList');
  if (!workflows.length) { list.innerHTML = '<div class="empty">No saved workflows yet. Type a task and click “☆ Save as workflow”.</div>'; return; }
  list.innerHTML = workflows.map((w) => `
    <div class="item">
      <div class="body"><div class="name" title="${esc(w.instruction)}">${esc(w.name)}</div>
        <div class="sub">${esc({ full: 'Full Auto', review: 'Review', step: 'Step-by-step' }[w.mode])}</div></div>
      <button class="small" data-run="${w.id}">▶ Run</button>
      <button class="link" data-del="${w.id}" title="Delete">✕</button>
    </div>`).join('');
  list.querySelectorAll('[data-run]').forEach((b) => b.addEventListener('click', () => {
    const w = workflows.find((x) => x.id === b.dataset.run);
    if (!w || running) return;
    setMode(w.mode);
    showTab('agent');
    runTask(w.instruction, w.mode);
  }));
  list.querySelectorAll('[data-del]').forEach((b) => b.addEventListener('click', async () => {
    workflows = workflows.filter((x) => x.id !== b.dataset.del);
    await store.set('workflows', workflows);
    renderWorkflows();
  }));
}

function renderHistory() {
  const list = $('#historyList');
  if (!history.length) { list.innerHTML = '<div class="empty">No tasks yet.</div>'; return; }
  list.innerHTML = history.map((h) => `
    <div class="item">
      <div class="body"><div class="name" title="${esc(h.instruction)}">${esc(h.instruction)}</div>
        <div class="sub">${esc(new Date(h.time).toLocaleString())} · ${esc(h.title || h.url)} · ${h.counts.done} actions</div></div>
      <span class="badge ${esc(h.status)}">${esc(h.status)}</span>
    </div>`).join('');
}

// ======================================================================
// Settings
// ======================================================================
// Unsaved edits, so switching provider in the dropdown doesn't lose what you typed.
let draft;

function renderSettings() {
  draft = structuredClone(settings);
  $('#provider').value = providerOf(draft);
  $('#defaultMode').value = draft.mode;
  renderProviderFields();
}

function renderProviderFields() {
  const id = providerOf(draft);
  const p = PROVIDERS[id];
  $('#keyLabel').textContent = `${p.name} API key`;
  $('#apiKey').placeholder = p.keyHint;
  $('#apiKey').value = draft.keys[id] || '';
  $('#model').placeholder = p.defaultModel;
  $('#model').value = draft.models[id] || '';
  $('#keyLink').href = p.keyUrl;
  $('#keyLink').textContent = p.keyUrl.replace(/^https:\/\//, '');
  $('#testResult').textContent = '';
}

function readProviderFields() {
  const id = providerOf(draft);
  draft.keys[id] = $('#apiKey').value.trim();
  draft.models[id] = $('#model').value.trim();
  draft.mode = $('#defaultMode').value;
}

function onProviderChange() {
  readProviderFields();
  draft.provider = $('#provider').value;
  renderProviderFields();
}

async function saveSettings() {
  readProviderFields();
  settings = structuredClone(draft);
  setMode(settings.mode);
  await store.set('settings', settings);
  lastModelNotice = null;
  updateStatus();
  flash('#settingsSaved', '✓ Saved');
}

async function testKey() {
  readProviderFields();
  const s = structuredClone(draft);
  const p = PROVIDERS[providerOf(s)];
  if (!activeKey(s)) { flash('#settingsSaved', 'Enter a key first'); return; }
  const model = activeModel(s);
  const out = $('#testResult');
  out.style.color = '';
  out.textContent = `Testing ${p.name} · ${model}… (if it's busy I'll try other models)`;
  try {
    const used = await testAI(s);
    out.style.color = 'var(--ok)';
    out.textContent = used === model
      ? `✓ Connected to ${p.name} · ${used}. Click Save to use it.`
      : `✓ Connected. ${model} is busy or unavailable, so WebPilot will automatically use ${used}. Click Save to use it.`;
  } catch (e) {
    out.style.color = 'var(--danger)';
    out.textContent = `Connection failed: ${e.message}`;
  }
}

init();
