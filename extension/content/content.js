// WebPilot AI — content script.
// Injected on demand into the active tab. It does two things only:
//   1. snapshot(): describe the page's interactive elements in a compact, structured form
//   2. execute(): perform ONE whitelisted action (fill / select / check / uncheck / click)
// The AI never runs arbitrary JavaScript on the page — every action goes through these functions.

(() => {
  if (window.__webpilotLoaded) return;
  window.__webpilotLoaded = true;

  const PREFIX = 'w' + Math.random().toString(36).slice(2, 5) + '_';
  let seq = 0;

  const clean = (s, n = 120) => (s || '').replace(/\s+/g, ' ').trim().slice(0, n);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const textOf = (node) => clean(node ? node.innerText || node.textContent || '' : '');
  const humanize = (s) => clean((s || '').replace(/[_\-.\[\]]+/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2'));

  // ---------- visibility ----------
  function isVisible(el) {
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) return false;
    const s = getComputedStyle(el);
    return s.visibility !== 'hidden' && s.display !== 'none';
  }
  function isUsable(el) {
    if (el.closest('[aria-hidden="true"], [hidden], [inert]')) return false;
    if (isVisible(el)) return true;
    // custom-styled checkboxes/radios are often visually hidden but have a visible label
    if ((el.type === 'checkbox' || el.type === 'radio') && el.labels) {
      return [...el.labels].some(isVisible);
    }
    return false;
  }

  // ---------- labels ----------
  // Text of a <label>, without the text of controls nested inside it (e.g. <select> options) or required "*".
  function labelText(label) {
    if (!label.querySelector('select, textarea, input, button')) return textOf(label);
    const c = label.cloneNode(true);
    c.querySelectorAll('select, textarea, input, button').forEach((n) => n.remove());
    return clean(c.textContent);
  }
  const stripStar = (s) => clean(String(s).replace(/\s*\*\s*$/, '').replace(/\s\*\s/g, ' '));

  function labelFor(el) {
    return stripStar(rawLabelFor(el));
  }
  function rawLabelFor(el) {
    const by = el.getAttribute('aria-labelledby');
    if (by) {
      const t = clean(by.split(/\s+/).map((id) => textOf(document.getElementById(id))).join(' '));
      if (t) return t;
    }
    if (el.labels && el.labels.length) {
      const t = clean([...el.labels].map(labelText).join(' '));
      if (t) return t;
    }
    const aria = el.getAttribute('aria-label');
    if (aria) return clean(aria);
    const tag = el.tagName;
    if (tag === 'BUTTON' || tag === 'A' || el.getAttribute('role') === 'button') {
      const t = textOf(el) || el.value || el.title;
      if (t) return clean(t);
    }
    if (el.type === 'submit' || el.type === 'button' || el.type === 'reset') return clean(el.value || 'Submit');
    if (el.placeholder) return clean(el.placeholder);
    if (el.title) return clean(el.title);
    const prev = el.previousElementSibling;
    if (prev && !prev.matches('input,select,textarea,button')) {
      const t = textOf(prev);
      if (t && t.length < 80) return t;
    }
    const parent = el.parentElement;
    if (parent) {
      const t = textOf(parent);
      if (t && t.length < 80) return t;
    }
    return humanize(el.name || el.id);
  }

  function radiosOf(el) {
    const scope = el.form || document;
    return [...scope.querySelectorAll(`input[type="radio"][name="${CSS.escape(el.name)}"]`)];
  }
  function radioOptionLabel(r) {
    if (r.labels && r.labels.length) return clean([...r.labels].map(labelText).join(' ')) || humanize(r.value);
    const aria = r.getAttribute('aria-label');
    if (aria) return clean(aria);
    const next = r.nextSibling;
    const t = next ? clean(next.textContent || '') : '';
    return t || humanize(r.value);
  }
  function radioGroupLabel(radios) {
    return stripStar(rawRadioGroupLabel(radios));
  }
  function rawRadioGroupLabel(radios) {
    const first = radios[0];
    const fs = first.closest('fieldset');
    if (fs) {
      const lg = fs.querySelector('legend');
      if (lg && textOf(lg)) return textOf(lg);
    }
    const rg = first.closest('[role="radiogroup"]');
    if (rg) {
      const t = rg.getAttribute('aria-label') ||
        (rg.getAttribute('aria-labelledby') && textOf(document.getElementById(rg.getAttribute('aria-labelledby'))));
      if (t) return clean(t);
    }
    // smallest container holding all radios of the group
    let p = first.parentElement;
    while (p && p.querySelectorAll(`input[type="radio"][name="${CSS.escape(first.name)}"]`).length < radios.length) p = p.parentElement;
    if (p) {
      const prev = p.previousElementSibling;
      if (prev && textOf(prev) && textOf(prev).length < 80) return textOf(prev);
      const head = p.firstElementChild;
      if (head && !head.querySelector('input') && !head.matches('input,label') && textOf(head)) return textOf(head);
    }
    return humanize(first.name);
  }

  // ---------- snapshot ----------
  const SELECTOR = 'input, textarea, select, button, a[href], [role="button"], [role="checkbox"], [contenteditable="true"]';

  function idOf(el) {
    if (!el.dataset.wpId) el.dataset.wpId = PREFIX + ++seq;
    return el.dataset.wpId;
  }

  function snapshot() {
    const out = [];
    const seenGroups = new Set();
    let links = 0;
    for (const el of document.querySelectorAll(SELECTOR)) {
      if (el.disabled || el.type === 'hidden') continue;
      if (el.closest('#__webpilot_overlay')) continue;
      if (!isUsable(el)) continue;
      const tag = el.tagName.toLowerCase();
      const type = (el.getAttribute('type') || '').toLowerCase();
      const base = { name: el.name || undefined, required: el.required || el.getAttribute('aria-required') === 'true' || undefined };

      if (type === 'radio') {
        const key = (el.form ? 'f' : 'd') + ':' + el.name;
        if (!el.name || seenGroups.has(key)) continue;
        seenGroups.add(key);
        const radios = radiosOf(el);
        const checked = radios.find((r) => r.checked);
        out.push({
          id: idOf(radios[0]), kind: 'radio-group', label: radioGroupLabel(radios), ...base,
          options: radios.map(radioOptionLabel), value: checked ? radioOptionLabel(checked) : '',
          empty: !checked,
        });
        continue;
      }
      if (type === 'checkbox' || el.getAttribute('role') === 'checkbox') {
        const checked = type === 'checkbox' ? el.checked : el.getAttribute('aria-checked') === 'true';
        out.push({ id: idOf(el), kind: 'checkbox', label: labelFor(el), checked, ...base });
        continue;
      }
      if (tag === 'select') {
        const opts = [...el.options];
        const sel = opts[el.selectedIndex];
        const empty = !sel || sel.value === '' || /^(select|choose|--|please)/i.test(sel.text.trim());
        out.push({
          id: idOf(el), kind: 'select', label: labelFor(el), ...base,
          options: opts.filter((o) => o.value !== '').map((o) => clean(o.text, 60)).slice(0, 60),
          value: sel && !empty ? clean(sel.text, 60) : '', empty,
        });
        continue;
      }
      if (tag === 'button' || type === 'submit' || type === 'button' || type === 'reset' || type === 'image' || el.getAttribute('role') === 'button') {
        out.push({ id: idOf(el), kind: 'button', label: labelFor(el), buttonType: type || (tag === 'button' ? 'submit' : undefined) });
        continue;
      }
      if (tag === 'a') {
        if (++links > 30) continue;
        const label = labelFor(el);
        if (!label) continue;
        out.push({ id: idOf(el), kind: 'link', label, href: clean(el.getAttribute('href'), 100) });
        continue;
      }
      if (el.isContentEditable && tag !== 'input' && tag !== 'textarea') {
        const v = textOf(el);
        out.push({ id: idOf(el), kind: 'editable', label: labelFor(el), value: v, empty: !v });
        continue;
      }
      if (tag === 'textarea' || tag === 'input') {
        if (['file', 'range', 'color'].includes(type)) continue;
        const secret = type === 'password';
        out.push({
          id: idOf(el), kind: tag === 'textarea' ? 'textarea' : 'text', inputType: type || 'text',
          label: labelFor(el), placeholder: clean(el.placeholder, 60) || undefined,
          autocomplete: el.getAttribute('autocomplete') || undefined, ...base,
          value: secret ? (el.value ? '••••' : '') : clean(el.value, 80), empty: !el.value,
        });
      }
      if (out.length >= 220) break;
    }
    const headings = [...document.querySelectorAll('h1, h2, h3, legend')]
      .filter(isVisible).map((h) => textOf(h)).filter(Boolean).slice(0, 8);
    return { url: location.href, title: document.title, headings, elements: out };
  }

  // ---------- option matching (CSE ⇄ Computer Science and Engineering) ----------
  const STOP = new Set(['and', 'of', 'the', 'in', 'for', '&']);
  const norm = (s) => (s || '').toLowerCase().replace(/[^a-z0-9+#.]+/g, ' ').trim();
  const initials = (s) => norm(s).split(' ').filter((w) => w && !STOP.has(w)).map((w) => w[0]).join('');

  function bestOption(options, wanted) {
    const w = norm(wanted);
    if (!w) return -1;
    const wCompact = w.replace(/ /g, '');
    let best = -1, bestScore = 0;
    options.forEach((o, i) => {
      const t = norm(o.text), v = norm(o.value);
      if (!t && !v) return;
      let s = 0;
      if (t === w || v === w) s = 100;
      else if (wCompact.length >= 2 && (initials(o.text) === wCompact || initials(wanted) === t.replace(/ /g, ''))) s = 90;
      else if (t && (t.startsWith(w) || w.startsWith(t))) s = 80;
      else if (t && (t.includes(w) || w.includes(t))) s = 70;
      else {
        const wt = w.split(' '), tt = new Set(t.split(' '));
        const hit = wt.filter((x) => tt.has(x) && !STOP.has(x)).length;
        s = hit ? (60 * hit) / Math.max(wt.length, tt.size) : 0;
      }
      if (s > bestScore) { bestScore = s; best = i; }
    });
    return bestScore >= 30 ? best : -1;
  }

  // ---------- value setters ----------
  function setNativeValue(el, value) {
    const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype
      : el.tagName === 'SELECT' ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
    setter.call(el, value); // works with React/Vue controlled inputs
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function toISODate(v) {
    const s = String(v).trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
    let m = s.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{4})$/); // dd/mm/yyyy (day first)
    if (m) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
    m = s.match(/^(\d{4})[\/\-.](\d{1,2})[\/\-.](\d{1,2})$/);
    if (m) return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
    const d = new Date(s);
    if (!isNaN(d)) return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    return s;
  }

  function isSecretField(el) {
    const ac = (el.getAttribute('autocomplete') || '').toLowerCase();
    return el.type === 'password' || ac.startsWith('cc-') || ac === 'one-time-code' || ac.includes('password');
  }

  // ---------- highlight overlay ----------
  let overlayTimer;
  function highlight(el, text) {
    let box = document.getElementById('__webpilot_overlay');
    if (!box) {
      box = document.createElement('div');
      box.id = '__webpilot_overlay';
      box.innerHTML = '<div class="__wp_badge"></div>';
      Object.assign(box.style, {
        position: 'absolute', zIndex: 2147483647, pointerEvents: 'none', borderRadius: '8px',
        border: '2px solid #6d5dfc', boxShadow: '0 0 0 4px rgba(109,93,252,.25), 0 0 18px rgba(109,93,252,.45)',
        transition: 'all .2s ease',
      });
      const badge = box.firstChild;
      Object.assign(badge.style, {
        position: 'absolute', top: '-24px', left: '-2px', background: '#6d5dfc', color: '#fff',
        font: '600 11px/1 system-ui, sans-serif', padding: '5px 8px', borderRadius: '6px', whiteSpace: 'nowrap',
      });
      document.documentElement.appendChild(box);
    }
    const target = el.type === 'checkbox' || el.type === 'radio' ? (el.labels && el.labels[0]) || el : el;
    const r = target.getBoundingClientRect();
    Object.assign(box.style, {
      display: 'block', top: `${r.top + scrollY - 4}px`, left: `${r.left + scrollX - 4}px`,
      width: `${r.width + 8}px`, height: `${r.height + 8}px`,
    });
    box.firstChild.textContent = 'WebPilot · ' + text;
    clearTimeout(overlayTimer);
    overlayTimer = setTimeout(() => { box.style.display = 'none'; }, 1600);
  }

  // ---------- execute ----------
  async function execute(action, value) {
    const el = document.querySelector(`[data-wp-id="${CSS.escape(action.target || '')}"]`);
    if (!el) throw new Error('The element is no longer on the page (it may have changed).');
    if (!el.isConnected || el.disabled) throw new Error('The element is disabled or not available.');
    el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    await sleep(220);

    const label = el.type === 'radio' ? radioGroupLabel(radiosOf(el)) : labelFor(el);
    let type = action.type;
    if (type === 'fill' && (el.tagName === 'SELECT' || el.type === 'radio')) type = 'select';
    if (type === 'select' && el.tagName !== 'SELECT' && el.type !== 'radio') type = 'fill';

    switch (type) {
      case 'fill': {
        if (isSecretField(el)) throw new Error('WebPilot never fills passwords, OTPs or card details.');
        highlight(el, `Filling “${label}”`);
        el.focus();
        if (el.isContentEditable && el.tagName !== 'INPUT' && el.tagName !== 'TEXTAREA') {
          document.execCommand('selectAll', false);
          document.execCommand('insertText', false, String(value));
        } else {
          const v = el.type === 'date' ? toISODate(value) : String(value);
          setNativeValue(el, v);
        }
        el.dispatchEvent(new Event('blur', { bubbles: true }));
        return { detail: `filled “${label}”` };
      }
      case 'select': {
        highlight(el, `Selecting in “${label}”`);
        if (el.tagName === 'SELECT') {
          const opts = [...el.options].filter((o) => o.value !== '');
          const idx = bestOption(opts.map((o) => ({ text: o.text, value: o.value })), value);
          if (idx < 0) throw new Error(`No option matching “${value}” in “${label}”.`);
          setNativeValue(el, opts[idx].value);
          return { detail: `chose “${clean(opts[idx].text, 60)}”` };
        }
        const radios = radiosOf(el);
        const idx = bestOption(radios.map((r) => ({ text: radioOptionLabel(r), value: r.value })), value);
        if (idx < 0) throw new Error(`No option matching “${value}” in “${label}”.`);
        if (!radios[idx].checked) radios[idx].click();
        return { detail: `chose “${radioOptionLabel(radios[idx])}”` };
      }
      case 'check':
      case 'uncheck': {
        const want = type === 'check';
        highlight(el, `${want ? 'Checking' : 'Unchecking'} “${clean(label, 40)}”`);
        if (el.getAttribute('role') === 'checkbox') {
          if ((el.getAttribute('aria-checked') === 'true') !== want) el.click();
        } else if (el.checked !== want) {
          el.click();
          if (el.checked !== want) {
            el.checked = want;
            el.dispatchEvent(new Event('change', { bubbles: true }));
          }
        }
        return { detail: want ? 'checked' : 'unchecked' };
      }
      case 'click': {
        highlight(el, `Clicking “${clean(label, 40)}”`);
        await sleep(350);
        el.click();
        return { detail: `clicked “${clean(label, 40)}”` };
      }
      default:
        throw new Error('Unsupported action: ' + action.type);
    }
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    (async () => {
      try {
        if (msg.cmd === 'ping') return sendResponse({ ok: true });
        if (msg.cmd === 'snapshot') return sendResponse({ ok: true, data: snapshot() });
        if (msg.cmd === 'execute') return sendResponse({ ok: true, data: await execute(msg.action, msg.value) });
        sendResponse({ ok: false, error: 'Unknown command' });
      } catch (e) {
        sendResponse({ ok: false, error: e.message || String(e) });
      }
    })();
    return true; // async response
  });
})();
