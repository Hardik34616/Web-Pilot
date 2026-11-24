// Safety rules: every action is classified before it runs.
//   routine   — filling ordinary fields
//   important — clicks, navigation, accepting terms
//   sensitive — final submit / payment / delete, protected profile fields
//   blocked   — passwords, OTPs, card numbers (never performed)

const SENSITIVE = /\b(submit|pay|payment|purchase|buy|checkout|place order|order now|delete|remove|deactivate|confirm|transfer|send|donate|subscribe|sign up|register|apply|finish|complete|book now|enroll|enrol)\b/i;
const NAV_SAFE = /\b(next|continue|back|previous|prev|proceed to step|save (and|&) continue|go to step)\b/i;
const TERMS = /\b(terms|agree|accept|consent|privacy|policy|conditions|declare|declaration)\b/i;
const SECRET = /\b(otp|cvv|cvc|card number|credit card|debit card|password|passcode|atm pin|upi pin|security code|aadhaar|ssn|pan number)\b/i;

export function isSecretField(el) {
  if (!el) return false;
  return el.inputType === 'password' || /^cc-|one-time-code|password/.test(el.autocomplete || '') || SECRET.test(el.label || '');
}

export function classify(action, el, askKeys = []) {
  const label = el?.label || action.description || '';
  if ((action.type === 'fill' || action.type === 'select') && isSecretField(el)) {
    return { level: 'blocked', reason: 'WebPilot never fills passwords, OTPs, card or ID numbers' };
  }
  if (action.type === 'navigate') return { level: 'important', reason: `opens ${action.url}` };
  if (action.type === 'click') {
    if ((SENSITIVE.test(label) && !NAV_SAFE.test(label)) || action.sensitive) {
      return { level: 'sensitive', reason: 'final or irreversible action (submit / pay / delete)' };
    }
    return { level: 'important', reason: 'clicks a button or link' };
  }
  if (action.type === 'check' || action.type === 'uncheck') {
    if (TERMS.test(label)) return { level: 'important', reason: 'accepts terms or a declaration' };
    return { level: action.sensitive ? 'sensitive' : 'routine', reason: '' };
  }
  if (action.profileKey && askKeys.includes(action.profileKey)) {
    return { level: 'sensitive', reason: `uses protected profile field “${action.profileKey}”` };
  }
  if (action.sensitive) return { level: 'sensitive', reason: 'marked sensitive by the planner' };
  return { level: 'routine', reason: '' };
}

/** Does this mode require the user to approve an action of this level? */
export function needsApproval(mode, level) {
  if (mode === 'step') return true;
  if (mode === 'review') return level !== 'routine';
  return level === 'sensitive'; // full auto still never submits/pays on its own
}
