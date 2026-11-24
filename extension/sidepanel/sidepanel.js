// WebPilot AI — side panel controller and agent loop.

import { PROFILE_FIELDS, FIELD_KEYS, effectiveProfile, IMPORT_PROMPT, parseImport } from './profile.js';
import { planWithAI, planHeuristic, fallbackPlan, testAI, makeTaskPlan, isPageChanging, GENERATED_PASSWORD_KEY } from './planner.js';
import { PROVIDERS, providerOf, activeKey, activeModel } from './providers.js';
import { classify, needsApproval } from './safety.js';
import { store } from './storage.js';

const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

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
      ${showVal ? `<div style="margin-top:4px">Value: <span class="val" style="white-space:pre-wrap">${esc(String(value).slice(0, 400))}${String(value).length > 400 ? '…' : ''}</span></div>` : ''}
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

const SUMMARY_TITLES = {
  achieved: '✅ Goal achieved',
  completed: '✅ Task complete',
  stopped: '⏹️ Task stopped',
  'needs-help': '🙋 I need your help',
  blocked: '🚫 This can’t be done here',
  'step-limit': '⏱️ Paused at the step limit',
  error: '❌ Something went wrong',
};

function addSummary({ status, counts, missing, note, downloads = [] }) {
  const d = document.createElement('div');
  const cls = ['achieved', 'completed'].includes(status) ? '' : status === 'error' ? 'bad' : 'warn';
  d.className = 'summary ' + cls;
  let body = note || '';
  if (missing.length) body += `${body ? '\n' : ''}I had no data for: ${missing.join(', ')}. Add it to your Profile, or tell me in the task.`;
  d.innerHTML = `<h4>${SUMMARY_TITLES[status] || status}</h4>
    <div class="stats"><span>✅ ${counts.done} done</span><span>⏭️ ${counts.skipped} skipped</span><span>❌ ${counts.failed} failed</span></div>
    <div style="white-space:pre-wrap">${esc(body)}</div>
    ${downloads.length ? '<div class="row"><button class="small" data-show>📂 Show in folder</button></div>' : ''}`;
  d.querySelector('[data-show]')?.addEventListener('click', () => chrome.downloads.show(downloads[downloads.length - 1].id));
  logEl().appendChild(d);
  scrollLog();
}

/** Hands control to the user (OTP, CAPTCHA, stuck…). Resolves {action: 'continue'|'stop', answer}. */
function askUser(question, { continueLabel = 'Done — continue' } = {}) {
  return new Promise((resolve) => {
    const card = document.createElement('div');
    card.className = 'approval ask';
    card.innerHTML = `
      <div class="ttl">🙋 Your turn</div>
      <div style="white-space:pre-wrap">${esc(question)}</div>
      <textarea rows="2" placeholder="Optional: type an answer or a hint for me"></textarea>
      <div class="btns">
        <button class="ok" data-d="continue">${esc(continueLabel)}</button>
        <button class="small" data-d="stop">Stop task</button>
      </div>`;
    logEl().appendChild(card);
    scrollLog();
    const ta = card.querySelector('textarea');
    const finish = (d) => {
      const answer = ta.value.trim();
      card.classList.add('answered');
      card.querySelector('.ttl').textContent += d === 'stop' ? ' — stopped' : answer ? ` — you said: “${answer}”` : ' — continued';
      pendingApproval = null;
      updateStatus('Working…');
      resolve({ action: d, answer });
    };
    card.querySelectorAll('button').forEach((b) => b.addEventListener('click', () => finish(b.dataset.d)));
    ta.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); finish('continue'); } });
    pendingApproval = finish;
    updateStatus('Waiting for you');
    ta.focus();
  });
}

function showPasswordCard(password, site) {
  const d = document.createElement('div');
  d.className = 'summary warn';
  d.innerHTML = `<h4>🔑 New password for ${esc(site)}</h4>
    <div style="display:flex;gap:6px;align-items:center;margin:4px 0">
      <code style="flex:1;font-size:13px;padding:5px 8px;word-break:break-all">${esc(password)}</code>
      <button class="small">Copy</button>
    </div>
    <div class="hint" style="margin:0">Save it in your password manager. It's also kept on this device under Workflows → History.</div>`;
  const btn = d.querySelector('button');
  btn.addEventListener('click', async () => {
    await navigator.clipboard.writeText(password);
    btn.textContent = '✓ Copied';
  });
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

const scriptable = (url) => /^(https?|file):/i.test(url || '');

async function inject(tabId) {
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: ['content/content.js'] });
  } catch (e) {
    const t = await chrome.tabs.get(tabId);
    if ((t.url || '').startsWith('file:')) {
      throw new Error('Chrome blocks extensions on local files by default. Open chrome://extensions → WebPilot AI → Details → enable “Allow access to file URLs”, or serve the page over http.');
    }
    throw new Error(`can't access this page (${e.message})`);
  }
}

async function send(tabId, msg) {
  const r = await chrome.tabs.sendMessage(tabId, msg);
  if (!r) throw new Error('The page did not respond.');
  if (!r.ok) throw new Error(r.error);
  return r.data;
}

// ---------- code editors (Monaco / CodeMirror / Ace) ----------
// These two functions are injected into the PAGE's own JavaScript world, where the editor objects live.
// They must be self-contained (no outer variables).
function pageEditor(op, id, code) {
  // Runs inside the page. Must be self-contained.
  const EDITORS = '.monaco-editor, .cm-editor, .CodeMirror, .ace_editor, [data-code-editor]';

  // Monaco: global namespace, AMD module, or an instance held in React state (e.g. @monaco-editor/react).
  function monacoNs() {
    if (window.monaco?.editor) return window.monaco;
    // Monaco's AMD loader returns an already-loaded module synchronously (it throws if it isn't loaded).
    for (const mod of ['vs/editor/editor.main', 'vs/editor/editor.api']) {
      try { const m = typeof window.require === 'function' && window.require(mod); if (m?.editor) return m; } catch (e) {}
    }
    return null;
  }
  function monacoFromReact(el) {
    const seen = new Set();
    const isEditor = (v) => v && typeof v === 'object' && typeof v.getModel === 'function' && typeof v.executeEdits === 'function';
    for (let n = el; n && n !== document.body; n = n.parentElement) {
      const key = Object.keys(n).find((k) => k.startsWith('__reactFiber$') || k.startsWith('__reactInternalInstance$'));
      if (!key) continue;
      for (let f = n[key], i = 0; f && i < 60; i++, f = f.return) {
        for (let h = f.memoizedState, j = 0; h && typeof h === 'object' && j < 60; j++, h = h.next) {
          for (const v of [h.memoizedState, h.memoizedState?.current]) {
            if (v && typeof v === 'object' && !seen.has(v)) { seen.add(v); if (isEditor(v)) return v; }
          }
        }
        for (const v of [f.stateNode, f.memoizedProps?.editor, f.memoizedProps?.editorRef?.current]) if (isEditor(v)) return v;
      }
      break;
    }
    return null;
  }
  function monacoEditor(el) {
    const ns = monacoNs();
    const fromNs = ns ? (ns.editor.getEditors?.() || []).find((e) => el.contains(e.getDomNode())) : null;
    return fromNs || monacoFromReact(el);
  }

  function api(el) {
    if (el.matches('.monaco-editor')) {
      const ed = monacoEditor(el);
      if (ed) return { how: 'monaco', get: () => ed.getValue(), set: (c) => { ed.focus(); ed.executeEdits('webpilot', [{ range: ed.getModel().getFullModelRange(), text: c, forceMoveMarkers: true }]); ed.pushUndoStop?.(); } };
    }
    if (el.matches('.cm-editor')) {
      const view = el.querySelector('.cm-content')?.cmView?.view;
      if (view) return { how: 'codemirror6', get: () => view.state.doc.toString(), set: (c) => view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: c } }) };
    }
    if (el.matches('.CodeMirror') && el.CodeMirror) return { how: 'codemirror5', get: () => el.CodeMirror.getValue(), set: (c) => el.CodeMirror.setValue(c) };
    if (el.matches('.ace_editor') && window.ace) { const ed = window.ace.edit(el); return { how: 'ace', get: () => ed.getValue(), set: (c) => ed.setValue(c, 1) }; }
    const ta = el.matches('textarea') ? el : el.querySelector('textarea');
    if (ta && !el.matches('.monaco-editor')) return { how: 'textarea', get: () => ta.value, set: (c) => { Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(ta, c); ta.dispatchEvent(new Event('input', { bubbles: true })); } };
    return null;
  }

  if (op === 'get') {
    const out = {};
    for (const el of document.querySelectorAll('[data-wp-id]')) {
      if (!el.matches(EDITORS)) continue;
      try { const e = api(el); if (e) out[el.dataset.wpId] = e.get(); } catch (e) {}
    }
    return out;
  }

  const el = document.querySelector('[data-wp-id="' + id + '"]');
  if (!el) return { ok: false, how: 'editor not found' };
  try {
    const e = api(el);
    if (e) { e.set(code); return { ok: true, how: e.how }; }
  } catch (err) { /* fall through */ }
  // Last resort: paste into the editor (works when the page has focus).
  const input = el.querySelector('textarea, [contenteditable="true"], .cm-content') || el;
  input.focus();
  document.execCommand('selectAll');
  const dt = new DataTransfer();
  dt.setData('text/plain', code);
  const notHandled = input.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
  if (notHandled) document.execCommand('insertText', false, code);
  return { ok: true, how: 'paste' };
}

const pageGetCode = () => pageEditor('get');

const normCode = (c) => String(c || '').replace(/\s+/g, '');

/** Replace the editor's code and confirm it actually landed. */
async function writeCode(tabId, editorId, code) {
  const [{ result } = {}] = await chrome.scripting.executeScript({ target: { tabId }, world: 'MAIN', func: pageEditor, args: ['set', editorId, code] });
  if (!result?.ok) throw new Error(`Couldn't write into the code editor (${result?.how || 'no editor'}).`);
  await sleep(250);
  const [{ result: now } = {}] = await chrome.scripting.executeScript({ target: { tabId }, world: 'MAIN', func: pageEditor, args: ['get'] });
  let landed = now?.[editorId];
  if (landed == null) { // no API access — read the DOM text instead
    const snap = await send(tabId, { cmd: 'snapshot' });
    landed = snap.elements.find((e) => e.id === editorId)?.value;
  }
  const want = normCode(code), got = normCode(landed);
  if (landed != null && !(got === want || got.includes(want.slice(0, 60)))) {
    throw new Error(result.how === 'paste'
      ? "This site's code editor doesn't expose an API and ignored pasted input while the page isn't focused. Click into the editor once, then let me continue."
      : 'The code did not land in the editor correctly. Try again.');
  }
  return { detail: `wrote ${code.split('\n').length} lines of code (${result.how})` };
}

/** Snapshot of the tab, or a stand-in description when the page can't be scripted. */
async function snapshotTab(tabId) {
  const t = await chrome.tabs.get(tabId);
  const isPdf = /\.pdf(\?|#|$)/i.test(t.url || '');
  const blank = (text) => ({ url: t.url || '', title: t.title || '', headings: [], elements: [], errors: [], popupText: '', scroll: { atTop: true }, text, isPdf });
  if (!scriptable(t.url)) return blank('(This is a browser page that WebPilot cannot read. Use "navigate" to open a website.)');
  if (isPdf) return blank('(This tab shows a PDF file. To save it, use download with this url.)');
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      await inject(tabId);
      const snap = await send(tabId, { cmd: 'snapshot' });
      if (snap.elements.some((e) => e.kind === 'code-editor')) {
        try {
          const [{ result } = {}] = await chrome.scripting.executeScript({ target: { tabId }, world: 'MAIN', func: pageEditor, args: ['get'] });
          for (const e of snap.elements) if (e.kind === 'code-editor' && result?.[e.id] != null) { e.value = result[e.id].slice(0, 6000); e.lines = result[e.id].split('\n').length; }
        } catch { /* DOM text is good enough */ }
      }
      return snap;
    } catch (e) {
      if (/file URLs/.test(e.message)) throw e;
      if (attempt === 3) return blank(`(WebPilot cannot read this page: ${e.message}. Try navigating somewhere else.)`);
      await sleep(800);
    }
  }
}

/** Wait for navigation / loading to finish after a page-changing action. */
async function settle(tabId) {
  await sleep(250);
  for (let i = 0; i < 150; i++) {
    const t = await chrome.tabs.get(tabId).catch(() => null);
    if (!t || t.status === 'complete') break;
    await sleep(100);
  }
  await sleep(350); // let single-page apps render
}

// ---------- downloads ----------
/** Records downloads that start while an action runs (e.g. a button that triggers a file). */
function watchDownloads() {
  const items = [];
  const on = (d) => items.push(d);
  chrome.downloads?.onCreated.addListener(on);
  return () => { chrome.downloads?.onCreated.removeListener(on); return items; };
}

async function waitForDownload(id, timeoutMs = 45000) {
  const t0 = Date.now();
  let item;
  while (Date.now() - t0 < timeoutMs) {
    [item] = await chrome.downloads.search({ id });
    if (!item || item.state !== 'in_progress') break;
    await sleep(300);
  }
  const file = (item?.filename || item?.url || 'file').split(/[\\/]/).pop();
  return { id, file, mime: item?.mime || '', state: item?.state || 'unknown', error: item?.error };
}

async function finishDownload(id) {
  const info = await waitForDownload(id);
  if (info.state === 'interrupted') throw new Error(`Download failed (${info.error || 'interrupted'}).`);
  const notPdf = /html/i.test(info.mime) ? ' — note: this is a web page, not a document' : '';
  return { detail: `saved ${info.file}${info.state === 'in_progress' ? ' (still downloading)' : ''}${notPdf}`, download: info };
}

async function downloadFile(a, tabId) {
  let url = a.url;
  if (!url && a.target) { await inject(tabId); url = await send(tabId, { cmd: 'href', target: a.target }); }
  if (url && !/^(javascript:|#)/i.test(url)) {
    const id = await chrome.downloads.download({ url, conflictAction: 'uniquify' });
    return finishDownload(id);
  }
  // No direct link (JavaScript button): click it and catch the download it starts.
  const stop = watchDownloads();
  await perform({ ...a, type: 'click' }, null, tabId);
  await sleep(2000);
  const started = stop();
  if (!started.length) throw new Error('This element has no file link and clicking it did not start a download. Open it and download the file page instead.');
  return finishDownload(started[0].id);
}

/** Detects a tab opened by the current one (links with target=_blank) so the agent can follow it. */
function watchNewTab(openerId) {
  let created = null;
  const onCreated = (t) => { if (t.openerTabId === openerId) created = t; };
  chrome.tabs.onCreated.addListener(onCreated);
  return () => { chrome.tabs.onCreated.removeListener(onCreated); return created; };
}

async function perform(a, value, tabId) {
  switch (a.type) {
    case 'navigate': await chrome.tabs.update(tabId, { url: a.url }); return { detail: 'opened page' };
    case 'back': await chrome.tabs.goBack(tabId); return { detail: 'went back' };
    case 'wait': await sleep(a.seconds * 1000); return { detail: `waited ${a.seconds}s` };
    case 'download': return downloadFile(a, tabId);
    case 'set_code': return writeCode(tabId, a.target, value);
    default:
      await inject(tabId);
      try {
        return await send(tabId, { cmd: 'execute', action: a, value, opts: { allowPassword: a.profileKey === GENERATED_PASSWORD_KEY } });
      } catch (e) {
        // the page navigated away before replying — that's what a click/Enter is supposed to do
        if (isPageChanging(a) && /port closed|receiving end|context invalidated|message channel/i.test(e.message)) return { detail: 'page is loading' };
        throw e;
      }
  }
}

const signature = (snap) => JSON.stringify([snap.url, snap.headings, snap.popupText, snap.elements.map((e) => [e.label, e.kind, e.value, e.checked, e.playing])]);

function makePassword() {
  const sets = ['ABCDEFGHJKLMNPQRSTUVWXYZ', 'abcdefghijkmnpqrstuvwxyz', '23456789', '!@#$%^&*-_+?'];
  const all = sets.join('');
  const rnd = (n) => { const a = new Uint32Array(1); crypto.getRandomValues(a); return a[0] % n; };
  const chars = sets.map((s) => s[rnd(s.length)]);
  while (chars.length < 16) chars.push(all[rnd(all.length)]);
  for (let i = chars.length - 1; i > 0; i--) { const j = rnd(i + 1); [chars[i], chars[j]] = [chars[j], chars[i]]; }
  return chars.join('');
}

function describeStep(a, el) {
  const label = el?.label ? ` “${el.label.slice(0, 60)}”` : '';
  switch (a.type) {
    case 'fill': return `typed ${a.profileKey === GENERATED_PASSWORD_KEY ? 'the generated password' : a.profileKey ? `profile.${a.profileKey}` : `"${a.value}"`} into${label} [${a.target}]`;
    case 'select': return `selected ${a.profileKey ? `profile.${a.profileKey}` : `"${a.value}"`} in${label} [${a.target}]`;
    case 'check': return `checked${label} [${a.target}]`;
    case 'uncheck': return `unchecked${label} [${a.target}]`;
    case 'click': return `clicked${label} [${a.target}]`;
    case 'press': return `pressed ${a.key || 'Enter'}${label ? ` in${label}` : ''}${a.target ? ` [${a.target}]` : ''}`;
    case 'navigate': return `navigated to ${a.url}`;
    case 'back': return 'went back';
    case 'scroll': return `scrolled ${a.direction}`;
    case 'wait': return `waited ${a.seconds}s`;
    case 'media': return `${a.op === 'pause' ? 'paused' : 'played'} media${a.target ? ` [${a.target}]` : ''}`;
    case 'set_code': return `wrote ${String(a.value || '').split('\n').length} lines of code into the editor [${a.target}]`;
    case 'download': return `downloaded${label || (a.url ? ` ${a.url.slice(0, 80)}` : '')}${a.target ? ` [${a.target}]` : ''}`;
    default: return a.type;
  }
}

function addTaskPlanCard(tp) {
  const card = document.createElement('div');
  card.className = 'taskplan';
  logEl().appendChild(card);
  let current = 1;
  const render = () => {
    card.innerHTML = `<div class="tp-head">🧭 Plan</div>
      <div class="tp-goal">${esc(tp.goal)}</div>
      <ol>${tp.steps.map((st, i) => {
        const n = i + 1, cls = n < current ? 'done' : n === current ? 'now' : '';
        return `<li class="${cls}"><span class="ic">${n < current ? '✅' : n === current ? '▶' : n}</span><span>${esc(st)}</span></li>`;
      }).join('')}</ol>
      ${tp.success ? `<div class="tp-done">🎯 Done when: ${esc(tp.success)}</div>` : ''}`;
  };
  render();
  scrollLog();
  return {
    update(n) { current = n; render(); },
    setSteps(steps) { tp.steps = steps; render(); },
  };
}

/** One system line that updates in place (for model switching / retries). */
function noticeLine() {
  let el = null;
  return (text) => {
    if (!el) { el = addMsg('system', text); el.classList.add('notice'); } else { el.textContent = text; scrollLog(); }
  };
}

const CHECK_TEXT = {
  media_playing: () => 'the video is playing',
  download_complete: () => 'the file finished downloading',
  text_visible: (c) => `the page shows “${c.text}”`,
  url_contains: (c) => `the address contains “${c.text}”`,
};

/** Evaluate the plan's machine-checkable success conditions locally (no AI call needed). */
async function checksPass(checks, snap, tabId, downloads) {
  const test = (sn) => checks.every((c) => {
    switch (c.type) {
      case 'media_playing': return sn.elements.some((e) => e.kind === 'media' && e.playing);
      case 'download_complete': return downloads.some((d) => d.state === 'complete');
      case 'text_visible': return [sn.text, sn.title, sn.popupText, ...(sn.headings || [])].join(' ').toLowerCase().includes(c.text.toLowerCase());
      case 'url_contains': return (sn.url || '').toLowerCase().includes(c.text.toLowerCase());
      default: return false;
    }
  });
  const why = checks.map((c) => CHECK_TEXT[c.type](c)).join(' and ');
  if (test(snap)) return { pass: true, snap, why };
  // a video often starts a moment after the page loads
  if (checks.some((c) => c.type === 'media_playing') && snap.elements.some((e) => e.kind === 'media' && !e.playing)) {
    let sn = snap;
    for (let i = 0; i < 3; i++) {
      await sleep(800);
      sn = await snapshotTab(tabId);
      if (test(sn)) return { pass: true, snap: sn, why };
    }
    return { pass: false, snap: sn };
  }
  return { pass: false, snap };
}

const hostOf = (u) => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return ''; } };
const sameSite = (a, b) => { const x = hostOf(a), y = hostOf(b); return !!x && (x === y || x.endsWith('.' + y) || y.endsWith('.' + x)); };

// ======================================================================
// Agent loop
// ======================================================================
const MAX_STEPS = 30;

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
  const useAI = !!activeKey(settings);
  if (!tab) return;
  if (!scriptable(tab.url) && !useAI) {
    addMsg('assistant', 'I can only work on regular web pages without an AI key. Open a website (or the demo form), or add a free Groq key in Settings so I can navigate on my own.');
    return;
  }

  setRunning(true);
  stopRequested = false;
  const modeName = { full: 'Full Auto', review: 'Review', step: 'Step-by-step' }[mode];
  addMsg('system', `Mode: ${modeName} · ${useAI ? `${PROVIDERS[providerOf(settings)].name.split(' ')[0]} agent` : 'offline matcher (add a free API key in Settings for the full agent)'}`);

  const prof = effectiveProfile(profile);
  const ctx = { askKeys, goal: instruction, codeEditor: false };
  const steps = [];           // what happened so far — fed back to the AI each step
  const missing = new Set();
  const counts = { done: 0, skipped: 0, failed: 0 };
  let tabId = tab.id;
  let status = 'stopped', note = '';
  let password = null, passwordSite = '';
  let failStreak = 0, lastError = '', repeatStreak = 0, lastPlanKey = '', lastSig = null, budget = MAX_STEPS;
  let nextSnap = null, submitClicked = false;
  let taskPlan = null, planCard = null, current = 1, pendingStart = null;
  const downloads = []; // {id, file, mime, state}
  const tried = new Set(); // built-in moves already used
  let emptyStreak = 0, aiFail = 0;

  const stuck = async (why) => {
    const r = await askUser(`${why}\nYou can fix it on the page yourself, or type a hint, then press Continue.`);
    if (r.action === 'stop') { stopRequested = true; status = 'stopped'; return false; }
    steps.push(r.answer ? `USER HINT: "${r.answer}"` : 'user intervened manually on the page — re-check it');
    failStreak = 0; repeatStreak = 0; lastPlanKey = '';
    return true;
  };

  try {
    // ---- 1. understand the command and plan before acting ----
    if (useAI) {
      updateStatus('Planning…');
      const first = await snapshotTab(tabId);
      nextSnap = first;
      try {
        taskPlan = await makeTaskPlan({ instruction, snapshot: first, profile: prof, settings, onNotice: noticeLine() });
        planCard = addTaskPlanCard(taskPlan);
        if (taskPlan.notes) addMsg('system', taskPlan.notes);
        if (taskPlan.startUrl && !sameSite(first.url, taskPlan.startUrl)) pendingStart = taskPlan.startUrl;
      } catch (e) {
        addMsg('system', `Couldn't make a plan first (${e.message}) — working it out step by step.`);
      }
    }

    for (let step = 1; !stopRequested; step++) {
      if (--budget < 0) {
        const r = await askUser(`I've taken ${MAX_STEPS} steps and the goal isn't confirmed yet. Should I keep going?`, { continueLabel: 'Keep going' });
        if (r.action === 'stop') { status = 'step-limit'; break; }
        if (r.answer) steps.push(`USER HINT: "${r.answer}"`);
        budget = MAX_STEPS;
      }

      let snap = nextSnap || await snapshotTab(tabId);
      nextSnap = null;
      if (taskPlan?.checks?.length && counts.done > 0) {
        const r = await checksPass(taskPlan.checks, snap, tabId, downloads);
        snap = r.snap;
        if (r.pass) {
          status = 'achieved';
          note = `Verified: ${r.why}.`;
          planCard?.update(taskPlan.steps.length + 1);
          break;
        }
      }
      const byId = Object.fromEntries(snap.elements.map((e) => [e.id, e]));
      ctx.codeEditor = snap.elements.some((e) => e.kind === 'code-editor');
      const sig = signature(snap);
      let host = snap.url;
      try { host = new URL(snap.url).hostname.replace(/^www\./, ''); } catch {}
      addMsg('system', `Step ${step} · ${host} · “${(snap.headings[0] || snap.title || '').slice(0, 60)}” · ${snap.elements.length} elements`);

      // ---- plan ----
      let plan;
      if (pendingStart) {
        // the plan already knows where to go — no need to ask the AI for that
        plan = { message: `Opening ${hostOf(pendingStart)}…`, status: 'in_progress', missing: [], planStep: 1, revisedSteps: null,
          actions: [{ type: 'navigate', url: pendingStart, description: `Open ${hostOf(pendingStart)}` }] };
        pendingStart = null;
      } else if (useAI) {
        updateStatus('Thinking…');
        try {
          plan = await planWithAI({
            instruction, snapshot: snap, profile: prof, history: steps, step, settings,
            taskPlan, current, downloads: downloads.map((d) => `"${d.file}" (${d.mime || 'unknown type'}, ${d.state})`),
            onNotice: noticeLine(),
          });
          aiFail = 0;
          if (plan.model !== lastModelNotice) updateStatus(`Thinking · ${plan.model}`);
          lastModelNotice = plan.model;
          if (plan.rejected?.length) steps.push(`YOUR LAST REPLY HAD INVALID ACTIONS — fix them: ${plan.rejected.join('; ')}`);
        } catch (e) {
          aiFail++;
          const move = fallbackPlan({ instruction, snapshot: snap, tried });
          const form = move ? null : planHeuristic({ instruction, snapshot: snap, profile: prof });
          if (move) {
            addMsg('system', `AI is busy — using a built-in move instead.`);
            plan = move;
          } else if (form.actions.length) {
            addMsg('system', 'AI is busy — using the offline form matcher for this page.');
            plan = form;
          } else if (aiFail <= 3) {
            noticeLine()(`All AI models are busy — retrying in ${aiFail * 5}s…`);
            await sleep(aiFail * 5000);
            nextSnap = snap;
            continue;
          } else {
            const r = await askUser(`I can't reach any AI model right now (${e.message}). Add a key for another provider in Settings, or retry.`, { continueLabel: 'Retry' });
            if (r.action === 'stop') { status = 'error'; note = e.message; break; }
            aiFail = 0;
            continue;
          }
        }
        updateStatus('Working…');
      } else {
        if (lastSig && sig === lastSig) {
          note = "The page didn't change after my last click, so I stopped. Please check the page for errors.";
          status = 'needs-help';
          break;
        }
        plan = planHeuristic({ instruction, snapshot: snap, profile: prof });
      }
      lastSig = sig;
      plan.missing.forEach((m) => missing.add(m));
      if (taskPlan && plan.revisedSteps?.length) { planCard.setSteps(plan.revisedSteps); addMsg('system', 'Plan updated to match the site.'); }
      if (taskPlan && plan.planStep) { current = Math.min(Math.max(plan.planStep, 1), taskPlan.steps.length); planCard.update(current); }
      if (taskPlan && plan.status === 'achieved' && !plan.actions.length) planCard.update(taskPlan.steps.length + 1);
      if (plan.message) addMsg('assistant', plan.message);
      else if (plan.thought) addMsg('system', plan.thought);

      // ---- finished? ----
      if (!plan.actions.length) {
        if (plan.status === 'achieved' || !useAI) { status = useAI ? 'achieved' : 'completed'; note = plan.evidence || ''; break; }
        if (plan.status === 'blocked') { status = 'blocked'; note = plan.message || plan.thought; break; }
        emptyStreak++;
        if (emptyStreak === 1) {
          steps.push('(your reply had no valid actions — return at least one action using ids copied from ELEMENTS, or status "achieved" with evidence)');
          nextSnap = snap;
          continue;
        }
        const move = fallbackPlan({ instruction, snapshot: snap, tried });
        if (move) {
          plan = move;
          addMsg('system', `Using a built-in move: ${move.message}`);
          steps.push(`(WebPilot took a built-in move: ${move.message})`);
        } else if (emptyStreak < 5) {
          plan = { message: '', status: 'in_progress', missing: [], actions: [{ type: 'scroll', direction: 'down', description: 'Scroll down to look for more options' }] };
        } else {
          if (!(await stuck('I couldn’t find a way forward on this page.'))) break;
          emptyStreak = 0;
          continue;
        }
      } else {
        emptyStreak = 0;
      }

      // ---- loop guard: same plan on an unchanged page ----
      const planKey = sig + JSON.stringify(plan.actions.map((a) => [a.type, a.target, a.value, a.url, a.key]));
      repeatStreak = planKey === lastPlanKey ? repeatStreak + 1 : 0;
      lastPlanKey = planKey;
      if (repeatStreak >= 2) {
        steps.push('(you proposed the same actions again and they had no effect — choose a DIFFERENT approach)');
        const move = repeatStreak < 4 ? fallbackPlan({ instruction, snapshot: snap, tried }) : null;
        if (move) {
          plan = move;
          addMsg('system', `Trying a different approach: ${move.message}`);
        } else if (repeatStreak < 4) {
          nextSnap = snap;
          continue;
        } else {
          if (!(await stuck(`I keep trying the same thing (“${plan.actions[0].description}”) and nothing changes.`))) break;
          continue;
        }
      }

      // ---- execute ----
      const card = addPlanCard(`Step ${step}`, plan.actions);
      let pageChanged = false, approveRest = false;

      for (let i = 0; i < plan.actions.length; i++) {
        if (stopRequested) { status = 'stopped'; break; }
        const a = plan.actions[i];
        const el = byId[a.target];

        if (a.type === 'ask_user') {
          card.set(i, 'waiting', 'waiting for you');
          const r = await askUser(a.question);
          if (r.action === 'stop') { card.set(i, 'skipped', 'stopped by you'); stopRequested = true; status = 'stopped'; break; }
          card.set(i, 'done', r.answer ? 'you answered' : 'you handled it');
          steps.push(`asked the user: "${a.question}" → ${r.answer ? `user answered: "${r.answer}"` : 'user says it is done — re-check the page'}`);
          pageChanged = true;
          break;
        }

        let value;
        if (a.profileKey === GENERATED_PASSWORD_KEY) {
          if (!password) { password = makePassword(); passwordSite = host; showPasswordCard(password, host); }
          value = password;
        } else if (a.type === 'fill' || a.type === 'select') {
          value = (a.profileKey && prof[a.profileKey]) || a.value;
        } else if (a.type === 'navigate') {
          value = a.url;
        } else if (a.type === 'set_code') {
          value = a.value;
        }
        if ((a.type === 'fill' || a.type === 'select') && (value == null || value === '')) {
          card.set(i, 'skipped', 'no value in your profile');
          missing.add(el?.label || a.profileKey);
          steps.push(`SKIPPED ${describeStep(a, el)}: profile has no "${a.profileKey}" — ask the user if it's required`);
          counts.skipped++;
          continue;
        }

        const risk = classify(a, el, ctx);
        if (risk.level === 'blocked') {
          card.set(i, 'skipped', risk.reason);
          steps.push(`BLOCKED ${describeStep(a, el)}: ${risk.reason}`);
          counts.skipped++;
          continue;
        }
        if (needsApproval(mode, risk.level) && !(approveRest && risk.level !== 'sensitive')) {
          card.set(i, 'waiting', 'waiting for your approval');
          const d = await askApproval({ action: a, el, value: a.profileKey === GENERATED_PASSWORD_KEY ? '•••••••• (generated)' : value, risk, mode });
          if (d === 'stop') { card.set(i, 'skipped', 'stopped by you'); stopRequested = true; status = 'stopped'; break; }
          if (d === 'skip') {
            card.set(i, 'skipped', 'skipped by you');
            steps.push(`user declined: ${describeStep(a, el)} — don't retry it, find another way or finish`);
            counts.skipped++;
            continue;
          }
          if (d === 'all') approveRest = true;
        }

        card.set(i, 'running');
        const changing = isPageChanging(a);
        const stopWatching = changing ? watchNewTab(tabId) : null;
        const stopDl = a.type === 'click' || a.type === 'press' ? watchDownloads() : null;
        try {
          const res = await perform(a, value, tabId);
          counts.done++;
          if (res?.download) downloads.push(res.download);
          if (a.type === 'click' && /\b(submit|register|sign ?up|create|apply|pay|place order)\b/i.test(el?.label || '')) submitClicked = true;

          if (changing || a.type === 'scroll' || a.type === 'wait' || a.type === 'media') {
            if (changing) {
              await settle(tabId);
              for (const d of stopDl?.() || []) {
                const info = await waitForDownload(d.id, 30000);
                downloads.push(info);
                steps.push(`(that click started a download: "${info.file}", ${info.mime || 'unknown type'}, ${info.state})`);
              }
              const opened = stopWatching();
              if (opened) {
                tabId = opened.id;
                await chrome.tabs.update(tabId, { active: true }).catch(() => {});
                await settle(tabId);
                steps.push(`(a new tab opened — now working in it)`);
              }
            }
            const after = await snapshotTab(tabId);
            const changed = signature(after) !== sig;
            const outcome = changed ? `page changed → “${(after.headings[0] || after.title || '').slice(0, 60)}” ${after.url.slice(0, 100)}` : 'NO VISIBLE CHANGE';
            steps.push(`${describeStep(a, el)} → ${outcome}`);
            card.set(i, changed ? 'done' : 'failed', changed ? res?.detail : 'no visible change');
            nextSnap = after;
            if (changed) failStreak = 0; else { failStreak++; lastError = `“${a.description}” had no effect`; }
            if (changing) {
              pageChanged = true;
              for (let j = i + 1; j < plan.actions.length; j++) card.set(j, 'skipped', 'page changed — re-planning');
              break;
            }
          } else {
            card.set(i, 'done', res?.detail);
            steps.push(`${describeStep(a, el)} → ok`);
          }
        } catch (e) {
          stopWatching?.();
          stopDl?.();
          card.set(i, 'failed', e.message);
          counts.failed++;
          failStreak++;
          lastError = e.message;
          steps.push(`FAILED ${describeStep(a, el)}: ${e.message}`);
          for (let j = i + 1; j < plan.actions.length; j++) card.set(j, 'skipped', 're-planning after the failure');
          // A locked-down editor needs one real click from the user to give the page focus — ask right away.
          if (a.type === 'set_code' && /Click into the editor/.test(e.message)) {
            const r = await askUser('This site’s code editor only accepts input when the page is focused. Click once inside the code editor, then press Continue and I’ll write the solution.');
            if (r.action === 'stop') { stopRequested = true; status = 'stopped'; }
            else { failStreak = 0; steps.push('user clicked into the code editor — retry set_code now'); }
          }
          break; // re-plan with the failure in mind instead of giving up
        }
        await sleep(mode === 'full' ? 40 : 150);
      }

      if (stopRequested) break;
      if (failStreak === 3) steps.push('(several attempts failed — change strategy: use the site search, a menu, scroll, a direct URL, or a Google search)');
      if (failStreak >= 7 && !(await stuck(`I'm stuck — my last attempts didn't work (${lastError}).`))) break;
      if (!useAI && (plan.done || !pageChanged)) {
        status = 'completed';
        note = submitClicked ? 'The form was submitted.' : 'Everything I could fill is filled in. I did not submit — review the page and submit when you are ready.';
        break;
      }
    }
  } catch (e) {
    status = 'error';
    addMsg('error', e.message);
  }

  if (stopRequested && !['stopped', 'step-limit'].includes(status)) status = 'stopped';
  const done = downloads.filter((d) => d.state !== 'interrupted');
  if (done.length) note = `${note ? note + '\n' : ''}📥 Saved to your Downloads folder: ${done.map((d) => d.file).join(', ')}`;
  addSummary({ status, counts, missing: [...missing].filter(Boolean), note, downloads: done });
  setRunning(false);
  stopRequested = false;

  history.unshift({
    time: Date.now(), url: tab.url, title: tab.title, instruction, mode, status, counts,
    password: password ? { site: passwordSite, value: password } : undefined,
    downloads: downloads.length ? downloads.map((d) => d.file) : undefined,
  });
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
      ${h.password ? `<button class="pw" data-pw="${esc(h.password.value)}" title="Copy the password created for ${esc(h.password.site)}">🔑</button>` : ''}
      <span class="badge ${esc(h.status)}">${esc(h.status)}</span>
    </div>`).join('');
  list.querySelectorAll('[data-pw]').forEach((b) => b.addEventListener('click', async () => {
    await navigator.clipboard.writeText(b.dataset.pw);
    b.textContent = '✓';
    setTimeout(() => { b.textContent = '🔑'; }, 1500);
  }));
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
    const used = await testAI({ ...s, keys: { [providerOf(s)]: activeKey(s) } }); // test only this provider
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
