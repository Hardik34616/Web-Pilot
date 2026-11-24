// Planner: decides the next actions toward the user's goal from the current page snapshot.
//  - planWithAI(): goal-driven LLM agent (Groq, OpenRouter or Gemini). It is called again after
//    every page change, sees what happened, verifies whether the goal is achieved and recovers from failures.
//    Profile VALUES are never sent to the model — it returns {profileKey} references resolved locally.
//  - planHeuristic(): offline form-filling fallback that works without an API key.

import { matchProfileKey, FIELD_KEYS } from './profile.js';
import { generateJSON, resetProviderCache } from './providers.js';

export const GENERATED_PASSWORD_KEY = 'generatedPassword';

const TYPES = new Set(['fill', 'select', 'check', 'uncheck', 'click', 'press', 'navigate', 'back', 'scroll', 'wait', 'media', 'ask_user']);
const NEEDS_TARGET = new Set(['fill', 'select', 'check', 'uncheck', 'click']);
const PAGE_CHANGING = new Set(['click', 'press', 'navigate', 'back']);
const clean = (s, n = 160) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, n);

const NEXT_RE = /^\s*(next|continue|proceed|save (and|&) (next|continue)|go to step \d+)\b/i;
const SUBMIT_RE = /\b(submit|register|apply|sign up|finish|complete registration|send application)\b/i;
const TERMS_RE = /\b(terms|agree|accept|consent|privacy policy|conditions|declare|declaration)\b/i;

export const isPageChanging = (a) => PAGE_CHANGING.has(a.type);

// ---------- shared ----------
function describeElement(e) {
  const kind = e.kind === 'text' ? `input:${e.inputType}` : e.kind;
  const parts = [e.id, kind, `"${clean(e.label, 70)}"`];
  if (e.kind === 'select' || e.kind === 'radio-group') parts.push(`options=[${e.options.slice(0, 25).map((o) => clean(o, 35)).join(' | ')}]`);
  if (e.kind === 'checkbox') parts.push(e.checked ? 'checked' : 'unchecked');
  if (e.kind === 'media') parts.push(e.playing ? `PLAYING ${e.time}s/${e.duration || '?'}s` : `paused at ${e.time}s`);
  if ('value' in e && !['checkbox', 'media'].includes(e.kind)) parts.push(e.empty ? 'empty' : `value="${clean(e.value, 40)}"`);
  if (e.placeholder) parts.push(`placeholder="${e.placeholder}"`);
  if (e.kind === 'link' && e.href) parts.push(`href=${clean(e.href, 60)}`);
  if (e.required) parts.push('required');
  if (e.invalid) parts.push('INVALID');
  if (e.popup) parts.push('[in popup]');
  if (e.offscreen) parts.push('[below/above view]');
  return parts.join(' | ');
}

export function normalizePlan(raw, snapshot) {
  const byId = Object.fromEntries(snapshot.elements.map((e) => [e.id, e]));
  const actions = (Array.isArray(raw?.actions) ? raw.actions : [])
    .filter((a) => a && TYPES.has(a.type))
    .filter((a) => {
      if (a.type === 'navigate') return /^https?:\/\//i.test(a.url || '');
      if (a.type === 'ask_user') return !!clean(a.question || a.description);
      if (NEEDS_TARGET.has(a.type)) return !!byId[a.target];
      if (a.target && !byId[a.target]) delete a.target; // press / media may omit target
      return true;
    })
    .map((a) => {
      const el = byId[a.target];
      let type = a.type;
      if (el && type === 'fill' && (el.kind === 'select' || el.kind === 'radio-group')) type = 'select';
      if (el && type === 'select' && !(el.kind === 'select' || el.kind === 'radio-group')) type = 'fill';
      if (el && (type === 'fill' || type === 'select') && el.kind === 'checkbox') type = 'check';
      return {
        type,
        target: a.target,
        url: a.url,
        key: a.key ? String(a.key) : undefined,
        direction: a.direction === 'up' ? 'up' : 'down',
        seconds: Math.min(Math.max(Number(a.seconds) || 2, 1), 10),
        op: a.op === 'pause' ? 'pause' : 'play',
        question: clean(a.question || (type === 'ask_user' ? a.description : ''), 300) || undefined,
        profileKey: a.profileKey || undefined,
        value: a.value != null && a.value !== '' ? String(a.value) : undefined,
        description: clean(a.description, 120) || defaultDescription(type, el, a),
        sensitive: !!a.sensitive,
      };
    });
  // Anything after the first page-changing action would target a stale page, so cut there.
  const cut = actions.findIndex((a) => isPageChanging(a) || a.type === 'ask_user');
  const trimmed = (cut >= 0 ? actions.slice(0, cut + 1) : actions).slice(0, 15);
  const status = ['achieved', 'blocked', 'in_progress'].includes(raw?.status) ? raw.status : raw?.done === false ? 'in_progress' : 'achieved';
  return {
    thought: clean(raw?.thought, 300),
    message: clean(raw?.message, 400),
    evidence: clean(raw?.evidence, 300),
    status,
    actions: trimmed,
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
    case 'ask_user': return 'Ask you for help';
    default: return type;
  }
}

// ---------- LLM agent prompt ----------
const MAX_PROMPT_ELEMENTS = 170;

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

function buildPrompt({ instruction, snapshot: raw, profile, history, step }) {
  const keys = Object.keys(profile);
  const R = makeRedactor(profile, instruction);
  const snapshot = {
    ...raw,
    url: R(raw.url), title: R(raw.title), text: R(raw.text), popupText: R(raw.popupText),
    headings: raw.headings.map(R), errors: (raw.errors || []).map(R),
  };
  const els = raw.elements.slice(0, MAX_PROMPT_ELEMENTS).map((e) => ({ ...e, label: R(e.label), value: e.value != null ? R(e.value) : e.value }));
  return `You are WebPilot, an autonomous browser agent operating the user's real Chrome tab.
Your job is to fully ACHIEVE the user's GOAL end-to-end, step by step. After each step you will see the updated page, so you can check progress, verify results and fix mistakes. Do the work yourself — never tell the user to do something you can do.

GOAL
${instruction}

ACTIONS (each also has "description": short, human-readable)
- {"type":"fill","target":ID,"value":"text"} or {"type":"fill","target":ID,"profileKey":KEY}   type into an input / search box / textarea
- {"type":"select","target":ID,"value":"option" | "profileKey":KEY}   native dropdowns and radio groups
- {"type":"check","target":ID} / {"type":"uncheck","target":ID}
- {"type":"click","target":ID}   buttons, links, tabs, menu items, video results, custom dropdowns
- {"type":"press","target":ID,"key":"Enter"}   e.g. submit a search after typing (key can be Enter, Escape, Tab, ArrowDown)
- {"type":"navigate","url":"https://..."}   open a site or a direct URL (e.g. https://www.youtube.com/results?search_query=gta+6+trailer)
- {"type":"back"}   browser back
- {"type":"scroll","direction":"down"|"up"}   reveal more content / lazy-loaded results
- {"type":"wait","seconds":2}   wait for loading
- {"type":"media","target":ID,"op":"play"|"pause"}   control a <video>/<audio>
- {"type":"ask_user","question":"..."}   ONLY when a human is required: OTP / verification code, CAPTCHA, email/phone verification, logging in to an existing account, or information you don't have and can't infer

RULES
1. Use only element IDs listed under ELEMENTS. Return 1–6 actions. A page-changing action (click, press, navigate, back) must be LAST — you'll see the new page next step.
2. If the goal needs a different website, navigate there directly. Prefer direct URLs for searches when you know the site's URL pattern.
3. Close popups, cookie banners, "what's new" tours and sign-in nags that block the way (prefer "Close", "Reject all", "Not now", "Skip", "×").
4. Look at HISTORY. If an action failed or had "no visible change", do NOT repeat it — try another element, press Enter, scroll, wait, or use a URL.
5. Personal data: use "profileKey" (keys listed below). You never see the values; they're filled locally. Don't invent personal data. Literal "value" is fine for things in the goal or obvious choices (search text, quantity, etc.).
6. Creating a NEW account: for password and confirm-password fields use {"profileKey":"${GENERATED_PASSWORD_KEY}"} (WebPilot generates a strong password and shows it to the user). Accept required terms when the goal is to sign up/register. Logging in to an EXISTING account needs ask_user.
7. Never solve CAPTCHAs and never type OTPs, card numbers, CVV, bank or government ID numbers — use ask_user for those.
8. Never buy, pay or delete anything unless the goal explicitly says so; mark such clicks "sensitive": true.
9. Click final submit / sign-up / register buttons only if the goal asks for it (e.g. "create an account", "register", "submit", "apply").
10. VERIFY before finishing: set "status":"achieved" ONLY when the CURRENT page proves the goal is complete (e.g. the requested video shows PLAYING, a success/confirmation message is visible, results for the query are displayed, the form is filled as asked). Put that proof in "evidence" and return no actions. If not proven yet, status is "in_progress".
11. Use "blocked" only if the goal is truly impossible (explain in "message").

CURRENT PAGE (step ${step})
url: ${snapshot.url}
title: ${snapshot.title}
headings: ${snapshot.headings.join(' / ') || '-'}
${snapshot.popupText ? `OPEN POPUP: ${snapshot.popupText}\n` : ''}${snapshot.errors?.length ? `ERROR MESSAGES ON PAGE: ${snapshot.errors.join(' | ')}\n` : ''}scroll: ${snapshot.scroll?.atTop ? 'at top' : snapshot.scroll?.atBottom ? 'at bottom' : 'middle'}
visible text (excerpt): ${clean(snapshot.text, 900)}

ELEMENTS (id | kind | label | details)${raw.elements.length > els.length ? ` — first ${els.length} of ${raw.elements.length}, scroll to see others` : ''}
${els.map(describeElement).join('\n') || '(no interactive elements)'}

PROFILE KEYS WITH VALUES: ${keys.length ? keys.join(', ') : '(profile is empty)'}, ${GENERATED_PASSWORD_KEY}
Known keys without values: ${FIELD_KEYS.filter((k) => !keys.includes(k)).join(', ')}

HISTORY (oldest first)
${history.length ? history.slice(-18).map((h, i) => `${i + 1}. ${h}`).join('\n') : '(this is the first step)'}

Respond with ONLY this JSON:
{"thought":"what the page shows vs. the goal, and what to do next","status":"in_progress"|"achieved"|"blocked","evidence":"proof from the page when achieved","message":"one short sentence for the user","actions":[...]}`;
}

// ---------- AI planner (Groq / OpenRouter / Gemini) ----------
export async function planWithAI({ instruction, snapshot, profile, history = [], step = 1, settings, onNotice }) {
  const { raw, model } = await generateJSON(settings, buildPrompt({ instruction, snapshot, profile, history, step }), onNotice);
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
