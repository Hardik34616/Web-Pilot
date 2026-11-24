// Planner: the agent's brain.
//  - makeTaskPlan(): BEFORE acting, interpret the command — exact goal, the right website, a step list,
//    and what "done" looks like.
//  - planWithAI(): called on every page. Sees the plan, the page and the history, picks the next actions,
//    and only declares success when the page proves it. Profile VALUES are never sent to the model.
//  - planHeuristic(): offline form-filling fallback that works without an API key.

import { matchProfileKey, FIELD_KEYS } from './profile.js';
import { generateJSON, resetProviderCache } from './providers.js';

export const GENERATED_PASSWORD_KEY = 'generatedPassword';

const TYPES = new Set(['fill', 'select', 'check', 'uncheck', 'click', 'press', 'navigate', 'back', 'scroll', 'wait', 'media', 'download', 'set_code', 'ask_user']);
const NEEDS_TARGET = new Set(['fill', 'select', 'check', 'uncheck', 'click']);
const PAGE_CHANGING = new Set(['click', 'press', 'navigate', 'back']);
const clean = (s, n = 160) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, n);

const NEXT_RE = /^\s*(next|continue|proceed|save (and|&) (next|continue)|go to step \d+)\b/i;
const SUBMIT_RE = /\b(submit|register|apply|sign up|finish|complete registration|send application)\b/i;
const TERMS_RE = /\b(terms|agree|accept|consent|privacy policy|conditions|declare|declaration)\b/i;

export const isPageChanging = (a) => PAGE_CHANGING.has(a.type);

// ---------- shared ----------
function shortHref(href) {
  const h = String(href || '');
  if (h.startsWith('javascript:') || h === '#') return '';
  try {
    const u = new URL(h);
    const path = u.pathname + u.search;
    return (path.length > 55 ? '…' + path.slice(-55) : path) || '/';
  } catch { return clean(h, 55); }
}

function describeElement(e) {
  if (e.kind === 'code-editor') return `${e.id} | code-editor | "${e.label}" | ${e.lines || 0} lines — full content under CODE EDITOR below`;
  const kind = e.kind === 'text' ? (e.inputType === 'text' ? 'input' : `input:${e.inputType}`) : e.kind;
  const parts = [e.id, kind, `"${clean(e.label, 70)}"`];
  if (e.kind === 'select' || e.kind === 'radio-group') parts.push(`options=[${e.options.slice(0, 20).map((o) => clean(o, 30)).join('|')}]`);
  if (e.kind === 'checkbox') parts.push(e.checked ? 'checked' : 'unchecked');
  if (e.kind === 'media') parts.push(e.playing ? `PLAYING ${e.time}s/${e.duration || '?'}s` : `paused ${e.time}s`);
  if ('value' in e && !['checkbox', 'media'].includes(e.kind)) parts.push(e.empty ? 'empty' : `="${clean(e.value, 40)}"`);
  if (e.placeholder && e.placeholder !== e.label) parts.push(`ph="${e.placeholder}"`);
  if (e.kind === 'link' && e.href) { const h = shortHref(e.href); if (h) parts.push(`→${h}`); }
  if (e.pdf) parts.push('[PDF]');
  if (e.required) parts.push('req');
  if (e.invalid) parts.push('INVALID');
  if (e.popup) parts.push('[popup]');
  if (e.offscreen) parts.push('[offscreen]');
  return parts.join(' | ');
}

// Weaker models phrase actions in many ways — accept the common variants instead of dropping them.
const TYPE_ALIASES = {
  type: 'fill', type_text: 'fill', input: 'fill', enter_text: 'fill', write: 'fill', set: 'fill', set_value: 'fill', search: 'fill',
  choose: 'select', select_option: 'select', pick: 'select', tick: 'check', untick: 'uncheck',
  tap: 'click', click_element: 'click', press_button: 'click', follow: 'click',
  open: 'navigate', goto: 'navigate', go_to: 'navigate', visit: 'navigate', open_url: 'navigate', navigate_to: 'navigate', go: 'navigate',
  key: 'press', keypress: 'press', press_key: 'press', enter: 'press', submit: 'press',
  go_back: 'back', scroll_down: 'scroll', scroll_up: 'scroll', sleep: 'wait', pause_for: 'wait',
  play: 'media', pause: 'media', play_video: 'media', save: 'download', download_file: 'download',
  ask: 'ask_user', askuser: 'ask_user', ask_human: 'ask_user', human: 'ask_user',
  write_code: 'set_code', type_code: 'set_code', code: 'set_code', paste_code: 'set_code', replace_code: 'set_code',
  edit_code: 'set_code', enter_code: 'set_code', insert_code: 'set_code', solution: 'set_code', submit_code: 'set_code',
};
// ask_user is only for things a human must do; anything else, the agent should decide itself.
const HUMAN_ONLY = /\b(otp|one.?time|verification|verify|code|captcha|robot|log ?in|sign ?in|password|payment|card|upi|bank|aadhaar|which (one|of)|prefer|missing|not (in|on) (your|the) profile|don'?t have|do not have|provide|your (phone|email|address|name))\b/i;

function resolveTarget(a, snapshot, byId) {
  let t = a.target ?? a.id ?? a.element_id ?? a.elementId ?? a.element ?? a.ref ?? a.target_id ?? a.selector;
  if (t == null || t === '') return undefined;
  t = String(t).trim().replace(/^[\[\("'`]+|[\]\)"'`]+$/g, '');
  if (byId[t]) return t;
  if (/^\d+$/.test(t)) { const e = snapshot.elements.find((x) => x.id.endsWith('_' + t)); if (e) return e.id; }
  const want = t.toLowerCase();
  const els = snapshot.elements;
  const hit = els.find((e) => e.label.toLowerCase() === want) ||
    els.find((e) => e.label.toLowerCase().startsWith(want)) ||
    (want.length >= 4 && els.find((e) => e.label.toLowerCase().includes(want)));
  return hit ? hit.id : undefined;
}

export function normalizePlan(raw, snapshot) {
  const byId = Object.fromEntries(snapshot.elements.map((e) => [e.id, e]));
  let list = Array.isArray(raw) ? raw : raw?.actions ?? raw?.next_actions ?? (raw?.action && typeof raw.action === 'object' ? [raw.action] : raw?.next_action ? [raw.next_action] : []);
  if (!Array.isArray(list)) list = [list];
  const rejected = [];
  const actions = [];
  for (const orig of list) {
    if (!orig || typeof orig !== 'object') continue;
    const a = { ...orig };
    let kind = String(a.type ?? a.action ?? a.name ?? a.tool ?? '').toLowerCase().trim().replace(/[\s-]+/g, '_');
    const alias = kind;
    kind = TYPE_ALIASES[kind] || kind;
    if (!TYPES.has(kind)) { rejected.push(`unknown action type "${alias}"`); continue; }
    a.value = a.value ?? a.code ?? a.text ?? a.input ?? a.content ?? a.query ?? a.solution;
    a.url = a.url ?? a.href ?? a.link ?? (kind === 'navigate' && /^[\w.-]+\.[a-z]{2,}(\/|$)/i.test(String(a.value || '')) ? a.value : undefined);
    if (a.url && !/^https?:\/\//i.test(a.url) && /^[\w.-]+\.[a-z]{2,}/i.test(a.url)) a.url = 'https://' + a.url;
    if (alias === 'enter' || alias === 'submit') a.key = a.key || 'Enter';
    if (alias === 'pause') a.op = 'pause';
    if (alias === 'scroll_up') a.direction = 'up';
    let target = resolveTarget(a, snapshot, byId);
    let el = byId[target];
    if (el?.kind === 'code-editor' && (kind === 'fill' || kind === 'click')) kind = a.value != null ? 'set_code' : kind;
    if (kind === 'set_code') {
      if (!el || el.kind !== 'code-editor') { el = snapshot.elements.find((e) => e.kind === 'code-editor'); target = el?.id; }
      if (!el) { rejected.push('set_code: there is no code editor on this page'); continue; }
      if (a.value == null || !String(a.value).trim()) { rejected.push('set_code needs the full code in "value"'); continue; }
      actions.push({ type: 'set_code', target, value: String(a.value), description: clean(a.description, 120) || `Write the solution into the editor (` + String(a.value).split('\n').length + ` lines)` });
      continue;
    }
    if (alias === 'submit' && el?.kind === 'button') kind = 'click';
    if (kind === 'navigate' && !/^https?:\/\//i.test(a.url || '')) { rejected.push('navigate needs a full https:// url'); continue; }
    if (kind === 'ask_user') {
      const q = clean(a.question || a.description || a.value, 300);
      if (!q) continue;
      if (!HUMAN_ONLY.test(q)) { rejected.push(`ask_user "${clean(q, 60)}" — don't ask for permission or confirmation, decide and act yourself`); continue; }
      a.question = q;
    }
    if (kind === 'download' && !el && !/^https?:\/\//i.test(a.url || '')) { rejected.push('download needs a target id from ELEMENTS or a url'); continue; }
    if (NEEDS_TARGET.has(kind) && !el) {
      rejected.push(`${kind} target "${clean(a.target ?? a.id ?? a.element ?? '', 30)}" is not in ELEMENTS — use an id from the list`);
      continue;
    }
    let type = kind;
    if (el && type === 'fill' && (el.kind === 'select' || el.kind === 'radio-group')) type = 'select';
    if (el && type === 'select' && !(el.kind === 'select' || el.kind === 'radio-group')) type = 'fill';
    if (el && (type === 'fill' || type === 'select') && el.kind === 'checkbox') type = 'check';
    if (el && type === 'fill' && ['button', 'link'].includes(el.kind)) type = 'click';
    if ((type === 'fill' || type === 'select') && a.value == null && !a.profileKey) { rejected.push(`${type} on ${target} has no value or profileKey`); continue; }
    actions.push({
      type,
      target: el ? target : undefined,
      url: a.url,
      key: a.key ? String(a.key) : undefined,
      direction: a.direction === 'up' ? 'up' : 'down',
      seconds: Math.min(Math.max(Number(a.seconds) || 2, 1), 10),
      op: a.op === 'pause' ? 'pause' : 'play',
      question: a.question,
      profileKey: a.profileKey || a.profile_key || undefined,
      value: a.value != null && a.value !== '' ? String(a.value) : undefined,
      description: clean(a.description, 120) || defaultDescription(type, el, a),
      sensitive: !!a.sensitive,
    });
  }
  // Anything after the first page-changing action would target a stale page, so cut there.
  const cut = actions.findIndex((a) => isPageChanging(a) || a.type === 'ask_user');
  const trimmed = (cut >= 0 ? actions.slice(0, cut + 1) : actions).slice(0, 15);
  const st = String(raw?.status || '').toLowerCase();
  const status = ['achieved', 'blocked', 'in_progress'].includes(st) ? st : /done|complete|success/.test(st) ? 'achieved' : raw?.done === true ? 'achieved' : 'in_progress';
  return {
    thought: clean(raw?.thought, 300),
    message: clean(raw?.message, 400),
    evidence: clean(raw?.evidence, 300),
    status,
    planStep: Number.isFinite(+raw?.plan_step) ? +raw.plan_step : null,
    revisedSteps: Array.isArray(raw?.revised_steps) ? raw.revised_steps.map((x) => clean(x, 140)).filter(Boolean).slice(0, 12) : null,
    actions: trimmed,
    rejected,
    missing: (Array.isArray(raw?.missing) ? raw.missing : []).map((m) => clean(m, 60)).filter(Boolean),
    done: raw?.done !== undefined ? raw.done !== false : status !== 'in_progress',
  };
}

function defaultDescription(type, el, a) {
  const label = clean(el?.label, 50);
  switch (type) {
    case 'fill': return a.profileKey === GENERATED_PASSWORD_KEY ? `Enter a new secure password in “${label}”` : `Type ${a.profileKey ? `your ${a.profileKey}` : `“${clean(a.value, 40)}”`} in “${label}”`;
    case 'select': return `Choose ${a.value ? `“${a.value}”` : `your ${a.profileKey}`} in “${label}”`;
    case 'check': return `Tick “${label}”`;
    case 'uncheck': return `Untick “${label}”`;
    case 'click': return `Click “${label}”`;
    case 'press': return `Press ${a.key || 'Enter'}${label ? ` in “${label}”` : ''}`;
    case 'navigate': return `Open ${a.url}`;
    case 'back': return 'Go back to the previous page';
    case 'scroll': return `Scroll ${a.direction === 'up' ? 'up' : 'down'} to see more`;
    case 'wait': return `Wait ${a.seconds || 2}s for the page`;
    case 'media': return a.op === 'pause' ? 'Pause the video' : 'Play the video';
    case 'download': return `Download ${label ? `“${label}”` : 'the file'}`;
    case 'ask_user': return 'Ask you for help';
    default: return type;
  }
}

/**
 * Privacy: once WebPilot has typed profile data into a page, that data shows up in later snapshots
 * (field values, "Welcome, Asha"). Mask it before anything is sent to the AI. Values the user wrote
 * in the goal themselves are left alone.
 */
function makeRedactor(profile, goal) {
  const g = (goal || '').toLowerCase();
  const pairs = Object.entries(profile)
    .map(([k, v]) => [k, String(v).trim()])
    .filter(([, v]) => v.length >= 3 && !g.includes(v.toLowerCase()))
    .sort((a, b) => b[1].length - a[1].length)
    .map(([k, v]) => [new RegExp(v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), `[your ${k}]`]);
  return (s) => pairs.reduce((out, [re, rep]) => out.replace(re, rep), String(s ?? ''));
}

const today = () => new Date().toISOString().slice(0, 10);

// ---------- 1. task plan (once, before acting) ----------
function buildTaskPlanPrompt({ instruction, snapshot, profile }) {
  return `You are the planning brain of WebPilot, a browser agent that will carry out the user's command in their Chrome tab.
Before any browsing, interpret the command precisely and write a concrete plan.

USER COMMAND: ${instruction}
TODAY: ${today()}
CURRENT TAB: ${snapshot.url} — "${clean(snapshot.title, 80)}"
PAGE: ${(snapshot.headings || []).slice(0, 5).join(' / ')} — ${clean(snapshot.text, 500)}${(snapshot.elements || []).some((e) => e.kind === 'code-editor') ? '\nThis page has a CODE EDITOR (a coding problem). "Solve it" means: write the solution in the editor, submit, and fix it until the judge accepts it.' : ''}
USER PROFILE HAS: ${Object.keys(profile).join(', ') || '(empty)'}

Think it through:
- What exactly does the user want? Expand abbreviations and fill in implied details (exam names, years, "latest", file type). E.g. "NDA 1 2026 notification" = the official notification PDF for "National Defence Academy & Naval Academy Examination (I), 2026".
- Where is the right / official place to do it? Use your knowledge (UPSC exams → https://upsc.gov.in, SSC → https://ssc.gov.in, YouTube videos → https://www.youtube.com, Indian passport → https://www.passportindia.gov.in …). Prefer official sites over third-party ones. If you are not sure, start with a Google search: https://www.google.com/search?q=…
- Is the current tab already the right place? Then start_url is null.
- If the site has a search URL, start directly on the results (e.g. https://www.youtube.com/results?search_query=gta+6+official+trailer , https://www.google.com/search?q=… , https://www.amazon.in/s?k=…). This saves steps.
- Which concrete path would a person follow on that site (menus, sections, buttons)? Be specific.

Return ONLY JSON:
{"goal":"precise restatement with exact names/years",
 "start_url":"https://… or null",
 "steps":["short imperative step", "..."],
 "success":"what must be true / visible at the end (e.g. 'the PDF has been downloaded', 'video is playing')",
 "checks":[machine-checkable conditions that ALL hold only when the goal is done, chosen from
   {"type":"media_playing"} · {"type":"download_complete"} · {"type":"text_visible","text":"phrase shown only after success"} · {"type":"url_contains","text":"…"}
   — use [] if it can't be checked reliably],
 "notes":"key assumptions, if any"}
Use 3–8 steps. The last step verifies the result.`;
}

export async function makeTaskPlan({ instruction, snapshot, profile, settings, onNotice }) {
  const { raw } = await generateJSON(settings, buildTaskPlanPrompt({ instruction, snapshot, profile }), onNotice, { maxTokens: 600 });
  const steps = (Array.isArray(raw?.steps) ? raw.steps : []).map((s) => clean(s, 140)).filter(Boolean).slice(0, 10);
  return {
    goal: clean(raw?.goal, 300) || instruction,
    startUrl: /^https?:\/\//i.test(raw?.start_url || '') ? raw.start_url : null,
    steps: steps.length ? steps : ['Work towards the goal on the current page', 'Verify the result'],
    success: clean(raw?.success, 200),
    checks: (Array.isArray(raw?.checks) ? raw.checks : [])
      .filter((c) => c && ['media_playing', 'download_complete', 'text_visible', 'url_contains'].includes(c.type))
      .filter((c) => !['text_visible', 'url_contains'].includes(c.type) || clean(c.text).length >= 3)
      .map((c) => ({ type: c.type, text: c.text ? clean(c.text, 120) : undefined }))
      .slice(0, 4),
    notes: clean(raw?.notes, 200),
  };
}

// ---------- 2. step prompt (every page) ----------
const MAX_PROMPT_ELEMENTS = 110;

function buildPrompt({ instruction, snapshot: raw, profile, history, step, taskPlan, current, downloads }) {
  const keys = Object.keys(profile);
  const R = makeRedactor(profile, instruction);
  const snapshot = {
    ...raw,
    url: R(raw.url), title: R(raw.title), text: R(raw.text), popupText: R(raw.popupText),
    headings: raw.headings.map(R), errors: (raw.errors || []).map(R),
  };
  // drop duplicate links (same label + target) to keep the prompt small and fast
  const seen = new Set();
  const els = raw.elements.filter((e) => {
    if (e.kind !== 'link') return true;
    const k = e.label + '|' + e.href;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  }).slice(0, MAX_PROMPT_ELEMENTS).map((e) => ({ ...e, label: R(e.label), value: e.value != null ? R(e.value) : e.value }));

  const planText = taskPlan
    ? `TASK PLAN (made before starting — follow it, adapt if the site differs)
Goal: ${taskPlan.goal}
Done when: ${taskPlan.success || 'the goal is visibly complete'}
${taskPlan.steps.map((s, i) => `${i + 1}. ${i + 1 < current ? '[done] ' : i + 1 === current ? '[NOW] ' : ''}${s}`).join('\n')}`
    : `GOAL: ${instruction}`;

  return `You are WebPilot, an autonomous agent operating the user's real Chrome tab. Achieve the goal end-to-end; after each step you'll see the new page. Do the work yourself.

USER COMMAND: ${instruction}
${planText}

ACTIONS (each may have "description")
fill{target,value|profileKey} · select{target,value|profileKey} (native dropdown / radio) · check{target} · uncheck{target}
click{target} · press{target?,key:"Enter"|"Escape"|"Tab"|"ArrowDown"} · navigate{url} · back · scroll{direction:"down"|"up"} · wait{seconds}
media{target?,op:"play"|"pause"} · download{target (link/button) | url} — saves a file (use for PDFs/notifications/documents)
set_code{target,value} — replace ALL code in a code editor with your complete code (use \n for new lines in JSON)
ask_user{question} — ONLY for OTP/verification codes, CAPTCHA, logging into an existing account, or personal info you can't get. Never ask for permission or confirmation — decide yourself.

RULES
- Use only IDs from ELEMENTS. Return 1–8 actions; a click/press/navigate/back must be LAST.
- Batch: fill all visible fields of a form in one step.
- Close blocking popups/cookie banners/tours first ("Close", "Reject all", "Not now", "×").
- After typing a search, press Enter (or click the search button). Use direct URLs when you know them.
- To get a file: use download on the link (prefer [PDF] links). If the tab itself is a PDF, use download with the page url.
- The "id" in every action must be copied exactly from ELEMENTS (e.g. "target":"${els[0]?.id || 'w_1'}").
- Read HISTORY: never repeat an action that FAILED or had NO VISIBLE CHANGE — try another element, scroll, a menu, site search or a URL. If the page doesn't match the plan, adapt and send "revised_steps".
- Personal data → profileKey (values hidden from you). New-account passwords → profileKey "${GENERATED_PASSWORD_KEY}" in password and confirm fields. Never type OTPs/card/bank/ID numbers or solve CAPTCHAs (ask_user). Never pay/buy/delete unless asked.
- Click final submit/sign-up only if the command asks for it.
- CODING PROBLEMS (a code editor is on the page): read the whole problem statement in "text". Keep the editor's language, class name and function signature EXACTLY as in the existing code. Write a complete, correct, efficient solution that handles edge cases — no main() or input reading unless the template has it, no debug prints. set_code it, then click Submit (or Run, then Submit). Read JUDGE: if it is not accepted, work out the bug from the verdict (runtime error, wrong answer on a test, time limit) and set_code a fixed version. Done only when the judge shows accepted / all tests passed.
- status "achieved" ONLY when this page (or DOWNLOADS) proves "Done when" — give evidence, no actions. Otherwise "in_progress". "blocked" only if impossible.

PAGE (step ${step})
url: ${snapshot.url}
title: ${clean(snapshot.title, 100)}${raw.isPdf ? '\nTHIS TAB IS A PDF FILE — use download{url} with this url to save it.' : ''}
headings: ${snapshot.headings.join(' / ') || '-'}
${snapshot.popupText ? `POPUP: ${snapshot.popupText}\n` : ''}${snapshot.errors?.length ? `ERRORS: ${snapshot.errors.join(' | ')}\n` : ''}text: ${clean(snapshot.text, raw.elements.some((e) => e.kind === 'code-editor') ? 3500 : 600)}

ELEMENTS (id | kind | label | details)${raw.elements.length > els.length ? ` — ${els.length} of ${raw.elements.length}, scroll for more` : ''}
${els.map(describeElement).join('\n') || '(none)'}

${raw.elements.filter((e) => e.kind === 'code-editor').map((e) => `CODE EDITOR ${e.id} (${e.editorType}) — current content:
<<<
${String(e.value || '').slice(0, 4000)}
>>>
JUDGE / RESULT PANEL: ${R(raw.results) || 'nothing yet (not run or submitted)'}
`).join('')}PROFILE KEYS: ${keys.length ? keys.join(', ') : '(empty)'}, ${GENERATED_PASSWORD_KEY}
DOWNLOADS: ${downloads?.length ? downloads.join('; ') : 'none yet'}
HISTORY:
${history.length ? history.slice(-14).map((h, i) => `${i + 1}. ${R(h)}`).join('\n') : '(first step)'}

Reply ONLY with JSON:
{"thought":"page vs plan, what next","plan_step":<number of the plan step you are on>,"status":"in_progress"|"achieved"|"blocked","evidence":"proof when achieved","message":"short note for the user","actions":[...],"revised_steps":["only if the plan must change"]}`;
}

// ---------- AI planner (Groq / OpenRouter / Gemini) ----------
export async function planWithAI({ instruction, snapshot, profile, history = [], step = 1, taskPlan = null, current = 1, downloads = [], settings, onNotice }) {
  const prompt = buildPrompt({ instruction, snapshot, profile, history, step, taskPlan, current, downloads });
  const coding = snapshot.elements.some((e) => e.kind === 'code-editor');
  const { raw, model } = await generateJSON(settings, prompt, onNotice, { maxTokens: coding ? 3000 : 900 });
  const plan = normalizePlan(raw, snapshot);
  plan.model = model;
  return plan;
}

/** Sends a tiny test request; returns the model that answered. */
export async function testAI(settings) {
  resetProviderCache();
  const snapshot = { url: 'about:blank', title: 'Test', headings: [], elements: [], text: '' };
  const plan = await planWithAI({ instruction: 'Connection test: reply with status "achieved" and no actions.', snapshot, profile: {}, settings });
  return plan.model;
}

// ---------- built-in moves (used when the AI is unavailable or gets stuck) ----------
export function searchTerms(goal) {
  return String(goal || '').toLowerCase()
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/\b(please|can you|could you|open|go to|goto|visit|on|in|at|from|youtube|google|and|then|play|watch|listen to|search for|search|find|look up|the|a|an|video|song|me|for me|download|website|site|official site|it)\b/g, ' ')
    .replace(/[^\w\s.+-]/g, ' ').replace(/\s+/g, ' ').trim();
}

/** Deterministic next move for common situations. Returns a plan or null. 'tried' holds keys already used. */
export function fallbackPlan({ instruction, snapshot, tried = new Set() }) {
  const g = String(instruction || '').toLowerCase();
  const url = snapshot.url || '';
  const els = snapshot.elements || [];
  const terms = searchTerms(instruction);
  const wantsPlay = /\b(play|watch|listen|stream)\b/.test(g);
  const wantsDownload = /\b(download|save|pdf|notification|admit card|syllabus)\b/.test(g);
  const make = (key, message, actions) => (tried.has(key) ? null : (tried.add(key), normalizePlan({ message, status: 'in_progress', actions }, snapshot)));
  const words = terms.split(' ').filter((w) => w.length > 1 || /\d/.test(w));
  // "GTA 6" should match "Grand Theft Auto VI": understand acronyms and Roman numerals.
  const ROMAN = { i: '1', ii: '2', iii: '3', iv: '4', v: '5', vi: '6', vii: '7', viii: '8', ix: '9', x: '10' };
  const tokens = (t) => String(t).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().split(' ').filter(Boolean)
    .map((x) => (ROMAN[x] && x !== 'i' && x !== 'v' && x !== 'x' ? ROMAN[x] : x));
  const overlap = (t) => {
    const toks = tokens(String(t).replace(/\((i{1,3}|iv|v)\)/gi, (m, r) => ' ' + ROMAN[r.toLowerCase()] + ' '));
    const initials = toks.filter((x) => /^[a-z]/.test(x)).map((x) => x[0]).join('');
    return words.filter((w) => toks.includes(w) || (/^[a-z]{2,5}$/.test(w) && initials.includes(w)) || (w.length > 3 && String(t).toLowerCase().includes(w))).length;
  };
  // Prefer the original/official item over reactions, breakdowns and reviews, unless asked for those.
  const bonus = (t) => (/\bofficial\b/i.test(t) ? 3 : 0) -
    (/\b(breakdown|reaction|reacts?|review|explained|analysis|everything you missed|vs\.?|top \d+)\b/i.test(t) && !/breakdown|reaction|review|explain|analysis/.test(g) ? 4 : 0);

  // 1. a popup is in the way
  const close = els.find((e) => e.popup && e.kind === 'button' && /^(close|×|✕|x|reject all|reject|not now|no thanks|skip|dismiss|maybe later|got it|accept all|accept|ok|i agree)$/i.test(e.label.trim()));
  if (close) { const p = make('close:' + close.id, 'Closing the popup.', [{ type: 'click', target: close.id }]); if (p) return p; }

  // On a coding page the only sensible moves are the AI's (writing code) — never wander off to search.
  if (els.some((e) => e.kind === 'code-editor')) return null;

  // 2. YouTube
  if (/youtube\.com\/watch/.test(url) && wantsPlay) {
    const m = els.find((e) => e.kind === 'media');
    if (m && !m.playing) { const p = make('play:' + url, 'Starting the video.', [{ type: 'media', target: m.id, op: 'play' }]); if (p) return p; }
  }
  if (/youtube\.com\/results/.test(url) && wantsPlay) {
    const vids = els.filter((e) => e.kind === 'link' && /\/watch\?v=/.test(e.href || '') && e.label.length > 8 && !/^\d+:\d+/.test(e.label));
    const best = vids.map((v, i) => [v, overlap(v.label) * 10 + bonus(v.label) - i * 0.5]).sort((a, b) => b[1] - a[1])[0]?.[0];
    if (best) { const p = make('vid:' + best.id, `Opening “${clean(best.label, 60)}”.`, [{ type: 'click', target: best.id }]); if (p) return p; }
  }
  if (/youtube\.com/.test(url) && wantsPlay && terms && !/results|watch/.test(url)) {
    const p = make('ytsearch', 'Searching YouTube.', [{ type: 'navigate', url: 'https://www.youtube.com/results?search_query=' + encodeURIComponent(terms) }]);
    if (p) return p;
  }

  // 3. files
  if (snapshot.isPdf && wantsDownload) { const p = make('pdf:' + url, 'Saving this PDF.', [{ type: 'download', url }]); if (p) return p; }
  if (wantsDownload) {
    const pdfs = els.filter((e) => e.kind === 'link' && e.pdf).map((e) => [e, overlap(e.label + ' ' + (e.href || ''))]).sort((a, b) => b[1] - a[1]);
    if (pdfs[0] && (pdfs[0][1] > 0 || pdfs.length === 1)) { const p = make('dl:' + pdfs[0][0].id, `Downloading “${clean(pdfs[0][0].label, 50)}”.`, [{ type: 'download', target: pdfs[0][0].id }]); if (p) return p; }
  }

  // 4. Google results → the best matching result
  if (/google\.[a-z.]+\/search/.test(url)) {
    const res = els.filter((e) => e.kind === 'link' && e.href && !/google\./.test(e.href) && e.label.length > 10 && !e.offscreen)
      .map((e, i) => [e, overlap(e.label) * 10 + bonus(e.label) - i * 0.5]).sort((a, b) => b[1] - a[1]);
    if (res[0]) { const p = make('g:' + res[0][0].id, `Opening “${clean(res[0][0].label, 60)}”.`, [{ type: 'click', target: res[0][0].id }]); if (p) return p; }
  }

  // 4b. any page: a link whose text strongly matches what the user asked for (search results, menus, notices)
  if (words.length) {
    const need = Math.max(2, Math.ceil(words.length * 0.6));
    const links = els.filter((e) => (e.kind === 'link' || e.kind === 'button') && e.label.length > 3)
      .map((e, i) => [e, overlap(e.label) * 10 + bonus(e.label) - i * 0.01 - (e.offscreen ? 1 : 0)])
      .filter(([e, sc]) => overlap(e.label) >= Math.min(need, words.length))
      .sort((a, b) => b[1] - a[1]);
    if (links[0]) { const p = make('link:' + links[0][0].id, `Opening “${clean(links[0][0].label, 60)}”.`, [{ type: 'click', target: links[0][0].id }]); if (p) return p; }
  }

  // 5. a site search box
  const box = els.find((e) => (e.kind === 'text' || e.kind === 'editable') && (e.inputType === 'search' || /search/i.test(`${e.label} ${e.placeholder || ''} ${e.name || ''}`)));
  if (box && terms && String(box.value || '').toLowerCase() !== terms) {
    const p = make('box:' + box.id + terms, `Searching the site for “${terms}”.`, [{ type: 'fill', target: box.id, value: terms }, { type: 'press', target: box.id, key: 'Enter' }]);
    if (p) return p;
  }

  // 6. last resort: web search
  if (terms && !/google\./.test(url)) {
    const p = make('gsearch', 'Searching the web for it.', [{ type: 'navigate', url: 'https://www.google.com/search?q=' + encodeURIComponent(terms) }]);
    if (p) return p;
  }
  return null;
}

// ---------- offline heuristic planner ----------
/** Pull explicit values from the instruction: "select CSE as my branch", "my year is 3rd". */
export function parseOverrides(instruction) {
  const out = [];
  const end = String.raw`(?=\s*(?:[,.;!]|\band\b|\bthen\b|$))`;
  const re1 = new RegExp(String.raw`\b(?:select|choose|pick|set|use|put|enter|fill)\s+["“']?([^,.;"“”']+?)["”']?\s+(?:as|for|in|into)\s+(?:my\s+|the\s+)?([a-z][a-z /]{1,30}?)` + end, 'gi');
  const re2 = new RegExp(String.raw`\b(?:my|the)\s+([a-z][a-z /]{1,30}?)\s+(?:is|should be|=)\s+["“']?([^,.;"“”']+?)["”']?` + end, 'gi');
  let m;
  while ((m = re1.exec(instruction))) out.push({ field: m[2].trim(), value: m[1].trim() });
  while ((m = re2.exec(instruction))) out.push({ field: m[1].trim(), value: m[2].trim() });
  return out.filter((o) => !/^(this|that|it)\b|\b(details|form|page|info|information)$/i.test(o.field));
}

export function planHeuristic({ instruction, snapshot, profile }) {
  const customKeys = Object.keys(profile).filter((k) => !FIELD_KEYS.includes(k));
  const overrides = parseOverrides(instruction);
  const wantsTerms = TERMS_RE.test(instruction);
  const wantsSubmit = /\bsubmit\b/i.test(instruction) &&
    !/(prepare|ready|don'?t submit|do not submit|without submitting|before submit|for submission)/i.test(instruction);

  const actions = [], missing = [];
  for (const e of snapshot.elements) {
    if (['text', 'textarea', 'editable', 'select', 'radio-group'].includes(e.kind)) {
      const fieldKey = matchProfileKey(e, customKeys);
      const ov = overrides.find((o) => {
        const ok = matchProfileKey(o.field, customKeys);
        return (ok && ok === fieldKey) || e.label.toLowerCase().includes(o.field.toLowerCase());
      });
      const type = e.kind === 'select' || e.kind === 'radio-group' ? 'select' : 'fill';
      if (ov) {
        if (e.empty || clean(e.value).toLowerCase() !== ov.value.toLowerCase()) {
          actions.push({ type, target: e.id, value: ov.value, description: `${type === 'select' ? 'Choose' : 'Enter'} “${ov.value}” in “${clean(e.label, 50)}”` });
        }
      } else if (fieldKey && profile[fieldKey]) {
        if (e.empty) actions.push({ type, target: e.id, profileKey: fieldKey });
      } else if (e.required && e.empty) {
        missing.push(clean(e.label, 60));
      }
    } else if (e.kind === 'checkbox' && wantsTerms && !e.checked && TERMS_RE.test(e.label)) {
      actions.push({ type: 'check', target: e.id, description: `Accept “${clean(e.label, 60)}”` });
    }
  }
  const buttons = snapshot.elements.filter((e) => e.kind === 'button');
  const next = buttons.find((b) => NEXT_RE.test(b.label));
  const submit = buttons.find((b) => SUBMIT_RE.test(b.label));
  if (next) actions.push({ type: 'click', target: next.id, description: `Go to the next step (“${clean(next.label, 30)}”)` });
  else if (submit && wantsSubmit) actions.push({ type: 'click', target: submit.id, sensitive: true, description: `Submit the form (“${clean(submit.label, 30)}”)` });

  const fills = actions.filter((a) => a.type !== 'click').length;
  let message;
  if (!actions.length) message = 'I could not find anything to do on this page with your current profile.';
  else message = `I found ${fills} field${fills === 1 ? '' : 's'} I can complete on this page` +
    (next ? `, then I'll continue to the next step.` : submit && !wantsSubmit ? `. I'll stop before “${clean(submit.label, 30)}” so you can review.` : '.');

  return normalizePlan({ message, actions, missing, done: !next }, snapshot);
}
