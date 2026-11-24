// Thin wrapper over chrome.storage.local. Everything stays on this device.

const DEFAULTS = {
  profile: {},           // { fullName, email, ..., custom: { key: value } }
  askKeys: ['phone', 'dob', 'address'], // profile fields that need approval before use
  // provider: 'groq' | 'openrouter' | 'gemini'; keys/models are stored per provider
  settings: { provider: 'groq', keys: {}, models: {}, mode: 'review' },
  workflows: [],         // [{ id, name, instruction, mode, created }]
  history: [],           // [{ time, url, title, instruction, mode, status, counts }]
};

const RETIRED_MODELS = ['gemini-2.5-flash', 'gemini-2.0-flash', 'gemini-1.5-flash'];

function migrateSettings(v) {
  const s = { ...structuredClone(DEFAULTS.settings), ...v };
  s.keys = { ...(v.keys || {}) };
  s.models = { ...(v.models || {}) };
  // v0.1 stored a single Gemini key/model at the top level.
  if ('apiKey' in s || 'model' in s) {
    if (s.apiKey && !s.keys.gemini) s.keys.gemini = s.apiKey;
    if (s.model && !s.models.gemini) s.models.gemini = s.model;
    delete s.apiKey;
    delete s.model;
  }
  if (RETIRED_MODELS.includes(s.models.gemini)) delete s.models.gemini;
  return s;
}

export const store = {
  async get(key) {
    const r = await chrome.storage.local.get(key);
    const v = r[key];
    if (v === undefined) return structuredClone(DEFAULTS[key]);
    if (key === 'settings') return migrateSettings(v);
    return v;
  },
  async set(key, value) {
    await chrome.storage.local.set({ [key]: value });
  },
};
