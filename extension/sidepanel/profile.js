// Profile Vault: field definitions, matching labels → profile keys, and AI profile import.

export const PROFILE_FIELDS = [
  { key: 'fullName', label: 'Full name', group: 'Personal', syn: ['full name', 'your name', 'name', 'applicant name', 'candidate name', 'student name'] },
  { key: 'firstName', label: 'First name', group: 'Personal', syn: ['first name', 'given name', 'fname'] },
  { key: 'lastName', label: 'Last name', group: 'Personal', syn: ['last name', 'surname', 'family name', 'lname'] },
  { key: 'email', label: 'Email', group: 'Personal', syn: ['email', 'e-mail', 'email address', 'mail id', 'email id'] },
  { key: 'phone', label: 'Phone', group: 'Personal', syn: ['phone', 'mobile', 'mobile number', 'phone number', 'contact number', 'telephone', 'whatsapp', 'contact no'] },
  { key: 'dob', label: 'Date of birth', group: 'Personal', syn: ['date of birth', 'dob', 'birth date', 'birthday'], type: 'date' },
  { key: 'gender', label: 'Gender', group: 'Personal', syn: ['gender', 'sex'] },
  { key: 'address', label: 'Address', group: 'Personal', syn: ['address', 'street', 'address line', 'street address'] },
  { key: 'city', label: 'City', group: 'Personal', syn: ['city', 'town'] },
  { key: 'state', label: 'State', group: 'Personal', syn: ['state', 'province', 'region'] },
  { key: 'country', label: 'Country', group: 'Personal', syn: ['country', 'nationality'] },
  { key: 'pincode', label: 'PIN / ZIP code', group: 'Personal', syn: ['pincode', 'pin code', 'zip', 'zip code', 'postal code', 'postcode'] },

  { key: 'college', label: 'College / University', group: 'Academic', syn: ['college', 'college name', 'university', 'institute', 'institution', 'school'] },
  { key: 'degree', label: 'Degree', group: 'Academic', syn: ['degree', 'course', 'program', 'programme', 'qualification'] },
  { key: 'branch', label: 'Branch / Major', group: 'Academic', syn: ['branch', 'department', 'specialization', 'specialisation', 'major', 'stream', 'discipline'] },
  { key: 'year', label: 'Year of study', group: 'Academic', syn: ['year of study', 'current year', 'year', 'semester', 'study year'] },
  { key: 'gradYear', label: 'Graduation year', group: 'Academic', syn: ['graduation year', 'passing year', 'year of graduation', 'year of passing', 'batch'] },
  { key: 'cgpa', label: 'CGPA / Percentage', group: 'Academic', syn: ['cgpa', 'gpa', 'cpi', 'percentage', 'grade', 'marks'] },
  { key: 'rollNumber', label: 'Roll / USN number', group: 'Academic', syn: ['roll number', 'roll no', 'usn', 'enrollment number', 'enrolment number', 'registration number', 'student id'] },

  { key: 'skills', label: 'Skills', group: 'Professional', syn: ['skills', 'technical skills', 'technologies', 'tech stack', 'expertise'], multiline: true },
  { key: 'experience', label: 'Experience', group: 'Professional', syn: ['experience', 'work experience', 'internship experience', 'projects'], multiline: true },
  { key: 'bio', label: 'About / Bio', group: 'Professional', syn: ['about yourself', 'about you', 'about me', 'bio', 'summary', 'cover letter', 'why do you want', 'tell us about'], multiline: true },

  { key: 'linkedin', label: 'LinkedIn URL', group: 'Links', syn: ['linkedin', 'linkedin profile', 'linkedin url'] },
  { key: 'github', label: 'GitHub URL', group: 'Links', syn: ['github', 'github profile', 'github url'] },
  { key: 'portfolio', label: 'Portfolio / Website', group: 'Links', syn: ['portfolio', 'website', 'personal website', 'personal site'] },
  { key: 'resume', label: 'Resume link', group: 'Links', syn: ['resume', 'cv', 'resume link', 'resume url'] },
];

export const FIELD_KEYS = PROFILE_FIELDS.map((f) => f.key);

const AUTOCOMPLETE_MAP = {
  name: 'fullName', 'given-name': 'firstName', 'family-name': 'lastName', email: 'email',
  tel: 'phone', 'tel-national': 'phone', bday: 'dob', sex: 'gender', 'street-address': 'address',
  'address-line1': 'address', 'address-level2': 'city', 'address-level1': 'state',
  'country-name': 'country', country: 'country', 'postal-code': 'pincode', organization: 'college', url: 'portfolio',
};

const humanize = (s) => (s || '').replace(/[_\-.]+/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase().trim();
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Best profile key for a form field, by longest whole-word synonym match. */
export function matchProfileKey(field, customKeys = []) {
  if (typeof field === 'string') field = { label: field };
  const ac = (field.autocomplete || '').toLowerCase().split(/\s+/).pop();
  if (ac && AUTOCOMPLETE_MAP[ac]) return AUTOCOMPLETE_MAP[ac];
  const hay = ` ${humanize(field.label)} ${humanize(field.name)} ${humanize(field.placeholder)} `.toLowerCase();
  let best = null, bestLen = 0;
  const consider = (key, syn) => {
    if (syn.length > bestLen && new RegExp(`\\b${escapeRe(syn)}\\b`, 'i').test(hay)) { best = key; bestLen = syn.length; }
  };
  for (const f of PROFILE_FIELDS) f.syn.forEach((s) => consider(f.key, s));
  for (const k of customKeys) consider(k, humanize(k));
  return best;
}

/** Merge base + custom fields and derive first/last ⇄ full name. */
export function effectiveProfile(profile = {}) {
  const p = { ...(profile.custom || {}) };
  for (const k of FIELD_KEYS) if (profile[k]) p[k] = String(profile[k]).trim();
  if (p.fullName && (!p.firstName || !p.lastName)) {
    const parts = p.fullName.split(/\s+/);
    p.firstName ||= parts[0];
    p.lastName ||= parts.length > 1 ? parts.slice(1).join(' ') : '';
  }
  if (!p.fullName && p.firstName) p.fullName = [p.firstName, p.lastName].filter(Boolean).join(' ');
  for (const k of Object.keys(p)) if (!p[k]) delete p[k];
  return p;
}

// ---------- AI profile import ----------
export const IMPORT_PROMPT = `I'm setting up WebPilot AI, a browser assistant that fills web forms for me.
Based ONLY on what you already know about me from our past conversations and your memory, return my details as a single JSON object with exactly these keys:

${FIELD_KEYS.map((k) => `"${k}"`).join(', ')}

Rules:
- Use "" for anything you don't know. Do NOT guess or invent details.
- "skills" should be a comma-separated string.
- "dob" in YYYY-MM-DD format if known.
- You may add extra keys for other useful facts (e.g. "hobbies", "languages") as simple strings.
- Reply with ONLY the JSON object, no explanation.`;

/** Parse pasted text from ChatGPT / Gemini into {key: value}. Tolerates code fences and prose. */
export function parseImport(text) {
  let s = (text || '').trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  const start = s.indexOf('{'), end = s.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('No JSON object found. Paste the full reply from the assistant.');
  const obj = JSON.parse(s.slice(start, end + 1));
  const out = {};
  const put = (k, v) => {
    if (v == null) return;
    if (Array.isArray(v)) v = v.map((x) => (typeof x === 'object' ? Object.values(x).join(' ') : x)).join(', ');
    else if (typeof v === 'object') { for (const [ck, cv] of Object.entries(v)) put(`${k}_${ck}`, cv); return; }
    v = String(v).trim();
    if (v && !/^(unknown|n\/a|null|none)$/i.test(v)) out[k] = v;
  };
  for (const [k, v] of Object.entries(obj)) {
    const known = FIELD_KEYS.find((f) => f.toLowerCase() === k.toLowerCase()) || matchProfileKey(k);
    put(known && !out[known] ? known : k.replace(/[^\w]+/g, '_'), v);
  }
  return out;
}
