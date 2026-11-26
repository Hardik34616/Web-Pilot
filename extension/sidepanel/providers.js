// AI providers: one interface for Groq, OpenRouter and Gemini.
// generateJSON(settings, prompt) → { raw, model }. Speed matters for an agent, so:
//  - a rate-limited model is put on cooldown and the next model is used immediately (no waiting),
//  - only genuine overload / server errors get one quick retry,
//  - responses are capped (the agent only needs a small JSON object).

export const PROVIDERS = {
  groq: {
    name: 'Groq',
    kind: 'openai',
    base: 'https://api.groq.com/openai/v1',
    keyUrl: 'https://console.groq.com/keys',
    keyHint: 'gsk_…',
    defaultModel: 'llama-3.3-70b-versatile',
    // Ranked by substring. llama-4-scout is second because its free-tier token limit is much higher.
    preferred: ['llama-3.3-70b', 'llama-4-scout', 'gpt-oss-120b', 'kimi-k2', 'llama-4-maverick', 'qwen3-32b', 'gpt-oss-20b', 'llama-3.1-8b'],
    exclude: /(whisper|tts|guard|playai|orpheus|compound|distil|allam|safeguard)/i,
    fallbacks: ['meta-llama/llama-4-scout-17b-16e-instruct', 'openai/gpt-oss-120b', 'llama-3.1-8b-instant'],
  },
  openrouter: {
    name: 'OpenRouter (free models)',
    kind: 'openai',
    base: 'https://openrouter.ai/api/v1',
    keyUrl: 'https://openrouter.ai/keys',
    keyHint: 'sk-or-…',
    defaultModel: 'meta-llama/llama-3.3-70b-instruct:free',
    preferred: ['gemma-4-31b', 'nemotron-3.5-super-vl', 'gemma-4-26b', 'llama-3.3-70b', 'deepseek-chat', 'deepseek-v3', 'gpt-oss', 'qwen3', 'mistral-small', 'gemma-3-27b'],
    exclude: /(lyria|audio|embed|tts|^openrouter\/)/i,
    freeOnly: true,
    fallbacks: [],
  },
  gemini: {
    name: 'Google Gemini',
    kind: 'gemini',
    base: 'https://generativelanguage.googleapis.com/v1beta',
    keyUrl: 'https://aistudio.google.com/apikey',
    keyHint: 'AIza…',
    defaultModel: 'gemini-3.8-flash',
    preferred: ['flash', 'flash-lite', 'pro'],
    exclude: /(image|tts|audio|embed|live|vision|robotics|computer-use|native|exp-\d)/i,
    fallbacks: ['gemini-3.8-flash-lite', 'gemini-flash-latest', 'gemini-flash-lite-latest'],
  },
};

export const DEFAULT_PROVIDER = 'groq';

export const providerOf = (s) => PROVIDERS[s.provider] ? s.provider : DEFAULT_PROVIDER;
export const activeKey = (s) => (s.keys?.[providerOf(s)] || '').trim();
export const activeModel = (s) => (s.models?.[providerOf(s)] || '').trim() || PROVIDERS[providerOf(s)].defaultModel;

const SYSTEM = 'You are WebPilot, a browser-automation agent. Always respond with a single valid JSON object and nothing else.';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const modelCache = {};   // provider → { key, models }
const sticky = {};       // provider → last model that worked this session
const cooldown = {};     // "provider:model" → timestamp until which the model is rate-limited

class AIError extends Error {
  // kind: ratelimit | transient | unavailable | auth | jsonmode | other
  constructor(message, kind, retryAfter = 0) { super(message); this.kind = kind; this.retryAfter = retryAfter; }
}

function classifyError(status, message) {
  if (status === 401 || status === 403 || /invalid api key|api key not valid|permission denied|api_key_invalid|unauthorized/i.test(message)) return 'auth';
  if (status === 400 && /response_format|json_object|json mode/i.test(message)) return 'jsonmode';
  if (status === 404 || /decommissioned|no longer available|does not exist|not found|not supported|is not available|deprecated|no endpoints/i.test(message)) return 'unavailable';
  if (status === 429 || status === 413 || /rate limit|quota|resource.?exhausted|tokens per minute|requests per minute|too large/i.test(message)) return 'ratelimit';
  if (status >= 500 || /high demand|overloaded|unavailable|try again|json_validate_failed|failed to generate json/i.test(message)) return 'transient';
  return 'other';
}

function parseJSON(text) {
  let s = String(text || '').replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
  s = s.replace(/^```(?:json)?/i, '').replace(/```\s*$/, '').trim();
  const a = s.indexOf('{'), b = s.lastIndexOf('}');
  if (a < 0 || b <= a) throw new AIError('The AI returned an invalid plan', 'transient');
  try { return JSON.parse(s.slice(a, b + 1)); } catch { throw new AIError('The AI returned an invalid plan', 'transient'); }
}

async function request(url, opts) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 30000);
  try {
    return await fetch(url, { ...opts, signal: ctrl.signal });
  } catch (e) {
    throw new AIError(e.name === 'AbortError' ? 'Request timed out' : `Network error: ${e.message}`, 'transient');
  } finally {
    clearTimeout(timer);
  }
}

async function failFrom(res) {
  let msg = `HTTP ${res.status}`;
  try { const j = await res.json(); msg = j.error?.message || j.message || msg; } catch {}
  const header = parseFloat(res.headers?.get?.('retry-after') || '');
  const inText = parseFloat((msg.match(/try again in ([\d.]+)\s*s/i) || [])[1] || '');
  return new AIError(msg, classifyError(res.status, msg), header || inText || 0);
}

// ---------- OpenAI-compatible (Groq, OpenRouter) ----------
// Models the provider's own catalogue says accept images (filled during model discovery).
const visionIds = new Set();
export const isVisionModel = (id) => {
  const m = String(id);
  if (/lyria|tts|audio|embed/i.test(m)) return false; // music / speech / embedding models
  if (visionIds.has(m)) return true;
  return /llama-4|scout|maverick|vision|-vl\b|vl-|[-_]vl[-_:]|qwen[\w.-]*vl|gemini|gpt-4o|gpt-4\.1|pixtral|gemma-3|gemma-4|llava|glm-4\.\dv|omni/i.test(m);
};

async function openaiGenerate(p, model, key, prompt, { maxTokens = 900, jsonMode = true, effort = true, image = null } = {}) {
  const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` };
  if (p === PROVIDERS.openrouter) headers['X-Title'] = 'WebPilot AI';
  const body = {
    model,
    temperature: 0.1,
    max_tokens: maxTokens,
    messages: [{ role: 'system', content: SYSTEM }, { role: 'user', content: image ? [{ type: 'text', text: prompt }, { type: 'image_url', image_url: { url: image } }] : prompt }],
  };
  if (/gpt-oss/i.test(model)) { body.max_tokens = maxTokens + 1200; if (effort) body.reasoning_effort = 'low'; } // reasoning tokens count too
  if (jsonMode) body.response_format = { type: 'json_object' };
  const res = await request(`${p.base}/chat/completions`, { method: 'POST', headers, body: JSON.stringify(body) });
  if (!res.ok) {
    const err = await failFrom(res);
    if (image && res.status === 400 && /image|vision|multimodal|content must|image_url|not support/i.test(err.message)) return openaiGenerate(p, model, key, prompt, { maxTokens, jsonMode, effort });
    if (err.kind === 'jsonmode' && jsonMode) return openaiGenerate(p, model, key, prompt, { maxTokens, jsonMode: false, effort, image });
    if (res.status === 400 && effort && body.reasoning_effort && /reasoning/i.test(err.message)) return openaiGenerate(p, model, key, prompt, { maxTokens, jsonMode, effort: false, image });
    throw err;
  }
  const data = await res.json();
  return parseJSON(data.choices?.[0]?.message?.content);
}

async function openaiModels(p, key) {
  const res = await fetch(`${p.base}/models`, { headers: { Authorization: `Bearer ${key}` } });
  if (!res.ok) return [];
  const data = await res.json();
  const list = (data.data || []).filter((m) => m.active !== false);
  for (const m of list) {
    const mods = [...(m.architecture?.input_modalities || []), ...(m.input_modalities || []), ...(m.modalities || [])].map(String);
    if (mods.includes('image')) visionIds.add(m.id);
  }
  return list.map((m) => m.id).filter((id) => !p.freeOnly || id.endsWith(':free'));
}

// ---------- Gemini ----------
async function geminiGenerate(p, model, key, prompt, image = null) {
  const res = await request(`${p.base}/models/${encodeURIComponent(model)}:generateContent`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: SYSTEM }] },
      contents: [{ role: 'user', parts: image ? [{ text: prompt }, { inline_data: { mime_type: 'image/jpeg', data: image.split(',')[1] } }] : [{ text: prompt }] }],
      generationConfig: { temperature: 0.1, responseMimeType: 'application/json' },
    }),
  });
  if (!res.ok) throw await failFrom(res);
  const data = await res.json();
  return parseJSON(data.candidates?.[0]?.content?.parts?.map((x) => x.text || '').join(''));
}

async function geminiModels(p, key) {
  const res = await fetch(`${p.base}/models?pageSize=200`, { headers: { 'x-goog-api-key': key } });
  if (!res.ok) return [];
  const data = await res.json();
  const version = (n) => parseFloat((n.match(/gemini-(\d+(?:\.\d+)?)/) || [])[1] || 0);
  return (data.models || [])
    .filter((m) => (m.supportedGenerationMethods || []).includes('generateContent'))
    .map((m) => m.name.replace(/^models\//, ''))
    .filter((n) => /^gemini-/.test(n))
    .sort((a, b) => version(b) - version(a));
}

// ---------- model discovery + fallback ----------
async function availableModels(id, key) {
  if (modelCache[id]?.key === key) return modelCache[id].models;
  const p = PROVIDERS[id];
  let models = [];
  try {
    models = (p.kind === 'gemini' ? await geminiModels(p, key) : await openaiModels(p, key)).filter((m) => !p.exclude.test(m));
    const rank = (m) => { const i = p.preferred.findIndex((s) => m.toLowerCase().includes(s)); return i < 0 ? 99 : i; };
    models = models.map((m, i) => [m, i]).sort((x, y) => rank(x[0]) - rank(y[0]) || x[1] - y[1]).map((x) => x[0]);
  } catch {}
  modelCache[id] = { key, models };
  return models;
}

/**
 * Small models (≈ under 20B) can't drive a browser reliably — they return invalid actions and get stuck.
 * They are never used as automatic fallbacks (only if the user picks one explicitly).
 */
export function isWeakModel(id) {
  const m = String(id).toLowerCase();
  if (/scout|maverick|-a\d+b/.test(m)) return false; // mixture-of-experts models: small active size, strong overall
  if (/(^|[^a-z])(nano|tiny|micro)([^a-z]|$)|-mini\b|ling-|:free.*flash-lite/.test(m)) return true;
  const sizes = [...m.matchAll(/(\d+(?:\.\d+)?)b(?![a-z])/g)].map((x) => parseFloat(x[1]));
  return sizes.length > 0 && Math.max(...sizes) < 20;
}

/** Image-capable models each configured provider offers (used to warn when WebPilot would be blind). */
export async function visionModelsFor(settings) {
  const out = {};
  for (const id of Object.keys(PROVIDERS)) {
    const key = (settings.keys?.[id] || '').trim();
    if (!key) continue;
    const models = await availableModels(id, key);
    out[id] = models.filter((m) => isVisionModel(m) && !isWeakModel(m));
  }
  return out;
}

export function resetProviderCache() {
  for (const o of [modelCache, sticky, cooldown]) for (const k of Object.keys(o)) delete o[k];
}

/**
 * Ask the active provider for JSON.
 * Rate-limited models are skipped instantly (with a cooldown); overloaded ones get one quick retry.
 */
export async function generateJSON(settings, prompt, onNotice, opts = {}) {
  const main = providerOf(settings);
  // The chosen provider first, then any other provider the user saved a key for.
  let order = [main, ...Object.keys(PROVIDERS).filter((id) => id !== main && (settings.keys?.[id] || '').trim())];
  // With a screenshot, providers that have image-capable models go first, so the AI can actually see the page.
  if (opts.image) {
    const sees = {};
    for (const id of order) {
      const models = await availableModels(id, (settings.keys?.[id] || '').trim()).catch(() => []);
      sees[id] = models.some((m) => isVisionModel(m) && !isWeakModel(m)) || id === 'gemini';
    }
    order = [...order.filter((id) => sees[id]), ...order.filter((id) => !sees[id])];
  }
  let lastErr;
  for (const id of order) {
    try {
      const isLast = id === order[order.length - 1];
      return await generateWithProvider(id, settings, prompt, onNotice, { ...opts, allowWait: isLast });
    } catch (e) {
      lastErr = e;
      const next = order[order.indexOf(id) + 1];
      if (next) onNotice?.(`${PROVIDERS[id].name} ${e.isAuth ? 'rejected its key' : 'is busy'} — switching to ${PROVIDERS[next].name}…`);
    }
  }
  throw lastErr;
}

async function generateWithProvider(id, settings, prompt, onNotice, { maxTokens = 900, allowWait = true, image = null } = {}) {
  const p = PROVIDERS[id];
  const key = (settings.keys?.[id] || '').trim();
  if (!key) throw new AIError(`No ${p.name} API key set`, 'auth');
  const primary = id === providerOf(settings) ? activeModel(settings) : ((settings.models?.[id] || '').trim() || p.defaultModel);
  const discovered = await availableModels(id, key);
  const all = [...new Set([sticky[id], primary, ...discovered.filter((m) => !isWeakModel(m)).slice(0, 6), ...p.fallbacks].filter(Boolean))]
    .filter((m) => m === primary || !isWeakModel(m))
    .slice(0, 8);
  const now = Date.now();
  const ready = all.filter((m) => !(cooldown[`${id}:${m}`] > now));
  // If every model is cooling down, wait for the one that frees up first.
  let candidates = ready;
  if (!ready.length && !allowWait) throw new AIError(`All ${p.name} models are rate-limited`, 'ratelimit'); // another provider can take over now
  if (!ready.length) {
    const soonest = all.reduce((a, b) => ((cooldown[`${id}:${a}`] || 0) <= (cooldown[`${id}:${b}`] || 0) ? a : b));
    const wait = Math.min((cooldown[`${id}:${soonest}`] || 0) - now, 20000);
    onNotice?.(`All ${p.name} models are rate-limited — waiting ${Math.ceil(wait / 1000)}s…`);
    await sleep(Math.max(wait, 0));
    candidates = [soonest];
  }

  // With a screenshot, try models that can see first; others still get the text.
  if (image) candidates = [...candidates.filter(isVisionModel), ...candidates.filter((m) => !isVisionModel(m))];

  const errors = [];
  for (const model of candidates) {
    const img = image && isVisionModel(model) ? image : null;
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const raw = p.kind === 'gemini'
          ? await geminiGenerate(p, model, key, prompt, img)
          : await openaiGenerate(p, model, key, prompt, { maxTokens, image: img });
        sticky[id] = model;
        return { raw, model, sawImage: !!img };
      } catch (e) {
        if (e.kind === 'auth') { const err = new Error(`${p.name} rejected the API key: ${e.message}`); err.isAuth = true; throw err; }
        errors.push(`${model}: ${e.message}`);
        if (e.kind === 'transient' && attempt === 1) { await sleep(700); continue; }
        if (e.kind === 'ratelimit') cooldown[`${id}:${model}`] = Date.now() + Math.max(e.retryAfter || 0, 8) * 1000;
        if (e.kind === 'unavailable') cooldown[`${id}:${model}`] = Date.now() + 3600 * 1000;
        if (sticky[id] === model) delete sticky[id];
        onNotice?.(`${model} is ${e.kind === 'unavailable' ? 'unavailable' : e.kind === 'ratelimit' ? 'rate-limited' : 'busy'} — switching model…`);
        break;
      }
    }
  }
  throw new Error(`All ${p.name} models are busy or unavailable right now. (${errors.slice(-2).join(' · ')})`);
}
