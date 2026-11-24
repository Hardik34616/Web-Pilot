// AI providers: one interface for Groq, OpenRouter and Gemini.
// generateJSON(settings, prompt) → { raw, model }, with retry on overload and automatic
// fallback to other models from the same provider.

export const PROVIDERS = {
  groq: {
    name: 'Groq',
    kind: 'openai',
    base: 'https://api.groq.com/openai/v1',
    keyUrl: 'https://console.groq.com/keys',
    keyHint: 'gsk_…',
    defaultModel: 'llama-3.3-70b-versatile',
    // Ranked by substring; anything else the key can use comes after these.
    preferred: ['llama-3.3-70b', 'gpt-oss-120b', 'kimi-k2', 'llama-4-maverick', 'qwen3-32b', 'gpt-oss-20b', 'llama-4-scout', 'llama-3.1-8b'],
    exclude: /(whisper|tts|guard|playai|orpheus|compound|distil|allam|safeguard)/i,
    fallbacks: ['openai/gpt-oss-120b', 'llama-3.1-8b-instant'],
  },
  openrouter: {
    name: 'OpenRouter (free models)',
    kind: 'openai',
    base: 'https://openrouter.ai/api/v1',
    keyUrl: 'https://openrouter.ai/keys',
    keyHint: 'sk-or-…',
    defaultModel: 'meta-llama/llama-3.3-70b-instruct:free',
    preferred: ['llama-3.3-70b', 'deepseek-chat', 'deepseek-v3', 'gpt-oss', 'qwen3', 'mistral-small', 'gemma-3-27b'],
    exclude: /(vision|image|audio|embed)/i,
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

const SYSTEM = 'You are WebPilot, a browser-automation planner. Always respond with a single valid JSON object and nothing else.';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const modelCache = {};   // provider → { key, models }
const sticky = {};       // provider → last model that worked this session

class AIError extends Error {
  constructor(message, kind) { super(message); this.kind = kind; } // transient | unavailable | auth | jsonmode | other
}

function classifyError(status, message) {
  if (status === 401 || status === 403 || /invalid api key|api key not valid|permission denied|api_key_invalid|unauthorized/i.test(message)) return 'auth';
  if (status === 400 && /response_format|json_object|json mode/i.test(message)) return 'jsonmode';
  if (status === 404 || /decommissioned|no longer available|does not exist|not found|not supported|is not available|deprecated|no endpoints/i.test(message)) return 'unavailable';
  if (status === 429 || status === 413 || status >= 500 ||
      /high demand|overloaded|unavailable|try again|quota|rate limit|resource.?exhausted|tokens per minute|json_validate_failed|failed to generate json/i.test(message)) return 'transient';
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
  return new AIError(msg, classifyError(res.status, msg));
}

// ---------- OpenAI-compatible (Groq, OpenRouter) ----------
async function openaiGenerate(p, model, key, prompt, jsonMode = true) {
  const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` };
  if (p === PROVIDERS.openrouter) headers['X-Title'] = 'WebPilot AI';
  const body = {
    model,
    temperature: 0.1,
    messages: [{ role: 'system', content: SYSTEM }, { role: 'user', content: prompt }],
  };
  if (jsonMode) body.response_format = { type: 'json_object' };
  const res = await request(`${p.base}/chat/completions`, { method: 'POST', headers, body: JSON.stringify(body) });
  if (!res.ok) {
    const err = await failFrom(res);
    if (err.kind === 'jsonmode' && jsonMode) return openaiGenerate(p, model, key, prompt, false);
    throw err;
  }
  const data = await res.json();
  return parseJSON(data.choices?.[0]?.message?.content);
}

async function openaiModels(p, key) {
  const res = await fetch(`${p.base}/models`, { headers: { Authorization: `Bearer ${key}` } });
  if (!res.ok) return [];
  const data = await res.json();
  return (data.data || [])
    .filter((m) => m.active !== false)
    .map((m) => m.id)
    .filter((id) => !p.freeOnly || id.endsWith(':free'));
}

// ---------- Gemini ----------
async function geminiGenerate(p, model, key, prompt) {
  const res = await request(`${p.base}/models/${encodeURIComponent(model)}:generateContent`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: SYSTEM }] },
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
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
    const rank = (m) => { const i = p.preferred.findIndex((s) => m.includes(s)); return i < 0 ? 99 : i; };
    models = models.map((m, i) => [m, i]).sort((x, y) => rank(x[0]) - rank(y[0]) || x[1] - y[1]).map((x) => x[0]);
  } catch {}
  modelCache[id] = { key, models };
  return models;
}

export function resetProviderCache() {
  for (const k of Object.keys(modelCache)) delete modelCache[k];
  for (const k of Object.keys(sticky)) delete sticky[k];
}

/** Ask the active provider for JSON. Retries once on overload, then tries other models. */
export async function generateJSON(settings, prompt, onNotice) {
  const id = providerOf(settings);
  const p = PROVIDERS[id];
  const key = activeKey(settings);
  if (!key) throw new AIError(`No ${p.name} API key set`, 'auth');
  const primary = activeModel(settings);
  const discovered = await availableModels(id, key);
  const candidates = [...new Set([sticky[id], primary, ...discovered.slice(0, 6), ...p.fallbacks].filter(Boolean))].slice(0, 8);

  const errors = [];
  for (const model of candidates) {
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const raw = p.kind === 'gemini' ? await geminiGenerate(p, model, key, prompt) : await openaiGenerate(p, model, key, prompt);
        sticky[id] = model;
        return { raw, model };
      } catch (e) {
        if (e.kind === 'auth') throw new Error(`${p.name} rejected the API key: ${e.message}`);
        errors.push(`${model}: ${e.message}`);
        if (e.kind === 'transient' && attempt === 1) { await sleep(1500); continue; }
        if (sticky[id] === model) delete sticky[id];
        onNotice?.(`${model} is ${e.kind === 'unavailable' ? 'unavailable' : 'busy'} — trying another model…`);
        break;
      }
    }
  }
  throw new Error(`All ${p.name} models are busy or unavailable right now. (${errors.slice(-2).join(' · ')})`);
}
