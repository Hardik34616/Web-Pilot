// Planner: turns (instruction + page snapshot) into a structured list of actions.
//  - planWithAI(): LLM planner (Groq, OpenRouter or Gemini). Profile VALUES are never sent to the model — it only
//    sees which profile keys exist and returns {profileKey} references that are resolved locally.
//  - planHeuristic(): offline fallback that works without an API key (great for demos).

import { matchProfileKey, FIELD_KEYS } from './profile.js';
import { generateJSON, resetProviderCache } from './providers.js';

const TYPES = new Set(['fill', 'select', 'check', 'uncheck', 'click', 'navigate']);
const clean = (s, n = 160) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, n);

const NEXT_RE = /^\s*(next|continue|proceed|save (and|&) (next|continue)|go to step \d+)\b/i;
const SUBMIT_RE = /\b(submit|register|apply|sign up|finish|complete registration|send application)\b/i;
const TERMS_RE = /\b(terms|agree|accept|consent|privacy policy|conditions|declare|declaration)\b/i;

// ---------- shared ----------
function describeElement(e) {
  const parts = [e.id, e.kind === 'text' ? `input:${e.inputType}` : e.kind, `"${clean(e.label, 80)}"`];
  if (e.kind === 'select' || e.kind === 'radio-group') parts.push(`options=[${e.options.map((o) => clean(o, 40)).join(' | ')}]`);
  if (e.kind === 'checkbox') parts.push(e.checked ? 'checked' : 'unchecked');
  if ('value' in e && e.kind !== 'checkbox') parts.push(e.empty ? 'empty' : `value="${clean(e.value, 40)}"`);
  if (e.required) parts.push('required');
  if (e.kind === 'link') parts.push(`href=${e.href}`);
  if (e.placeholder) parts.push(`placeholder="${e.placeholder}"`);
  return parts.join(' | ');
}

export function normalizePlan(raw, snapshot) {
  const byId = Object.fromEntries(snapshot.elements.map((e) => [e.id, e]));
  const actions = (Array.isArray(raw?.actions) ? raw.actions : [])
    .filter((a) => a && TYPES.has(a.type))
    .filter((a) => (a.type === 'navigate' ? /^https?:\/\//i.test(a.url || '') : !!byId[a.target]))
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
        profileKey: a.profileKey || undefined,
        value: a.value != null && a.value !== '' ? String(a.value) : undefined,
        description: clean(a.description, 120) || defaultDescription(type, el, a),
        sensitive: !!a.sensitive,
      };
    })
    .slice(0, 40);
  return {
    message: clean(raw?.message, 400),
    actions,
    missing: (Array.isArray(raw?.missing) ? raw.missing : []).map((m) => clean(m, 60)).filter(Boolean),
    done: raw?.done !== false,
  };
}

function defaultDescription(type, el, a) {
  const label = clean(el?.label, 50);
  switch (type) {
    case 'fill': return `Fill “${label}”${a.profileKey ? ` from profile (${a.profileKey})` : ''}`;
    case 'select': return `Choose ${a.value ? `“${a.value}”` : `your ${a.profileKey}`} in “${label}”`;
    case 'check': return `Tick “${label}”`;
    case 'uncheck': return `Untick “${label}”`;
    case 'click': return `Click “${label}”`;
    case 'navigate': return `Open ${a.url}`;
    default: return type;
  }
}

// ---------- LLM prompt ----------
function buildPrompt({ instruction, snapshot, profile, completed }) {
  const keys = Object.keys(profile);
  return `You are WebPilot, a careful browser-automation planner inside a Chrome extension.
Convert the user's instruction into a JSON plan of actions on the CURRENT page only.

ACTION TYPES
- {"type":"fill","target":ID,"profileKey":KEY}  or  {"type":"fill","target":ID,"value":"literal text"}
- {"type":"select","target":ID,"profileKey":KEY | "value":"option text"}   (dropdowns AND radio groups)
- {"type":"check","target":ID} / {"type":"uncheck","target":ID}
- {"type":"click","target":ID}
- {"type":"navigate","url":"https://..."}
Every action also has "description" (short, human readable) and "sensitive" (boolean).

RULES
1. Use ONLY element IDs from the PAGE ELEMENTS list.
2. For the user's personal data use "profileKey" (one of AVAILABLE PROFILE KEYS). You never see profile values — they are filled in locally for privacy.
3. Use "value" only for things the user stated in the instruction (e.g. "select CSE as branch" → value "CSE") or obvious constants.
4. Skip fields that already hold the right value. Never invent data. If a required field has no data, add its label to "missing".
5. Never fill passwords, OTPs, card numbers or government ID numbers.
6. Do NOT click final submit / pay / delete / register buttons unless the user explicitly asked to submit. If they did, mark that click "sensitive": true.
7. If the page is one step of a multi-step form, fill this step and put the "Next"/"Continue" click as the LAST action, with done=false.
8. Set "done": true when nothing more needs to happen for this task (e.g. the form is filled and ready for the user to review).
9. Only check terms/consent boxes if the user asked to accept terms.

USER INSTRUCTION
${instruction}

PAGE
url: ${snapshot.url}
title: ${snapshot.title}
headings: ${snapshot.headings.join(' / ')}

PAGE ELEMENTS (id | kind | label | details)
${snapshot.elements.map(describeElement).join('\n')}

AVAILABLE PROFILE KEYS (have values)
${keys.length ? keys.join(', ') : '(none — profile is empty)'}
Known keys without values: ${FIELD_KEYS.filter((k) => !keys.includes(k)).join(', ')}

ALREADY COMPLETED IN EARLIER STEPS
${completed.length ? completed.map((c) => '- ' + c).join('\n') : '(nothing yet)'}

Respond with ONLY this JSON:
{"message":"one or two friendly sentences explaining what you will do","actions":[...],"missing":["labels"],"done":true}`;
}

// ---------- AI planner (Groq / OpenRouter / Gemini) ----------
export async function planWithAI({ instruction, snapshot, profile, completed, settings, onNotice }) {
  const { raw, model } = await generateJSON(settings, buildPrompt({ instruction, snapshot, profile, completed }), onNotice);
  const plan = normalizePlan(raw, snapshot);
  plan.model = model;
  return plan;
}

/** Sends a tiny test request; returns the model that answered. */
export async function testAI(settings) {
  resetProviderCache();
  const snapshot = { url: "about:blank", title: "Test", headings: [], elements: [] };
  const plan = await planWithAI({ instruction: "Say hello. Return no actions.", snapshot, profile: {}, completed: [], settings });
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
