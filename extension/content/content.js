// WebPilot AI — content script.
// Injected on demand into the active tab. It does two things only:
//   1. snapshot(): describe the page's interactive elements in a compact, structured form
//   2. execute(): perform ONE whitelisted action (fill / select / check / click / press / scroll / media)
// The AI never runs arbitrary JavaScript on the page — every action goes through these functions.

(() => {
  if (window.__webpilotLoaded) return;
  window.__webpilotLoaded = true;

  const PREFIX = 'w' + Math.random().toString(36).slice(2, 5) + '_';
  let seq = 0;

  const clean = (s, n = 120) => String(s || '').replace(/[\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/g, '').replace(/\s+/g, ' ').trim().slice(0, n);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const textOf = (node) => clean(node ? node.innerText || node.textContent || '' : '');
  const humanize = (s) => clean((s || '').replace(/[_\-.\[\]]+/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2'));

  // ---------- shadow-DOM-aware helpers ----------
  /** Parent across shadow boundaries (an element inside a shadow root → its host). */
  const composedParent = (n) => n.parentElement || (n.parentNode && n.parentNode.host) || null;
  /** a.contains(b), but also true when b lives inside a's (nested) shadow roots. */
  function deepContains(a, b) {
    for (let n = b; n; n = composedParent(n)) if (n === a) return true;
    return false;
  }
  /** elementFromPoint that descends into open shadow roots (document.elementFromPoint stops at the host). */
  function deepElementFromPoint(x, y) {
    let n = document.elementFromPoint(x, y);
    for (let i = 0; n && n.shadowRoot && i < 20; i++) {
      const inner = n.shadowRoot.elementFromPoint(x, y);
      if (!inner || inner === n) break;
      n = inner;
    }
    return n;
  }
  /** closest() that keeps walking out of shadow roots. */
  function deepClosest(el, sel) {
    for (let n = el; n; n = composedParent(n)) if (n.matches && n.matches(sel)) return n;
    return null;
  }
  const byIdIn = (el, id) => {
    const root = el.getRootNode ? el.getRootNode() : document;
    return (root.getElementById && root.getElementById(id)) || document.getElementById(id);
  };
  const isOurs = (n) => !!(n && n.closest && n.closest('#__webpilot_overlay, #__webpilot_marks'));

  // ---------- visibility ----------
  const FIELD_TAGS = /^(INPUT|SELECT|TEXTAREA)$/;
  function isVisible(el) {
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) {
      // display:contents wrappers have no box of their own — their children do
      if (getComputedStyle(el).display === 'contents') return [...el.children].some(isVisible);
      return false;
    }
    const s = getComputedStyle(el);
    if (s.visibility === 'hidden' || s.display === 'none' || s.contentVisibility === 'hidden') return false;
    // closed menus / faded-out panels (opacity 0 on an ancestor). Native fields are exempt: sites often lay an
    // invisible <select>/<input> over a custom-styled box, and it is still the thing to operate.
    if (el.checkVisibility && !FIELD_TAGS.test(el.tagName)) {
      try { if (!el.checkVisibility({ opacityProperty: true, visibilityProperty: true })) return false; } catch {}
    }
    return true;
  }
  function isUsable(el) {
    if (deepClosest(el, '[aria-hidden="true"], [hidden], [inert]')) return false;
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
  /** Text that sits just left of / above a field on screen (custom forms often have no <label>). */
  function nearbyText(el) {
    const r = el.getBoundingClientRect();
    if (!r.width || r.bottom < 0 || r.top > innerHeight) return '';
    const probes = [[r.left - 14, r.top + r.height / 2], [r.left + 6, r.top - 9], [r.left + r.width / 2, r.top - 9], [r.left - 40, r.top + r.height / 2]];
    for (const [x, y] of probes) {
      if (x < 0 || y < 0 || x > innerWidth || y > innerHeight) continue;
      const n = document.elementFromPoint(x, y);
      if (!n || n === el || n.contains(el) || el.contains(n) || n === document.body || n === document.documentElement) continue;
      if (n.matches('input, select, textarea, button') || n.closest('#__webpilot_overlay, #__webpilot_marks')) continue;
      // must be part of the same form area (not a popup drawn on top, not an unrelated block)
      let anc = el, related = false;
      for (let i = 0; i < 4 && anc; i++) {
        anc = anc.parentElement;
        if (!anc || anc === document.body || anc === document.documentElement) break;
        if (anc.contains(n)) { related = true; break; }
      }
      if (!related) continue;
      // never use a CAPTCHA picture/text as a label (WebPilot does not solve CAPTCHAs)
      if (/captcha/i.test(`${n.className} ${n.id} ${el.placeholder || ''} ${el.name || ''} ${el.id || ''}`)) continue;
      const t = clean(n.innerText || n.textContent, 60);
      if (t && t.length >= 2 && t.length <= 50) return t.replace(/\s*\*\s*$/, '');
    }
    return '';
  }

  function rawLabelFor(el) {
    const by = el.getAttribute('aria-labelledby');
    if (by) {
      const t = clean(by.split(/\s+/).map((id) => textOf(byIdIn(el, id))).join(' '));
      if (t) return t;
    }
    if (el.labels && el.labels.length) {
      const t = clean([...el.labels].map(labelText).join(' '));
      if (t) return t;
    }
    const aria = el.getAttribute('aria-label');
    const tag = el.tagName;
    // Some sites ship broken aria-labels (template errors, raw HTML, huge strings). Prefer the visible text then.
    const visible = /^(INPUT|SELECT|TEXTAREA)$/.test(tag) ? '' : textOf(el);
    const junk = aria && (/SafeValue|binding|<\/?[a-z]|\{\{|\bundefined\b|\bnull\b|function\s*\(/i.test(aria) || (aria.length > 80 && visible && visible.length < 60));
    if (aria && !junk) return clean(aria);
    if (junk && visible) return clean(visible);
    if (tag === 'BUTTON' || tag === 'A' || el.getAttribute('role') === 'button') {
      const t = textOf(el) || el.value || el.title;
      if (t) return clean(t);
    }
    if (el.type === 'submit' || el.type === 'button' || el.type === 'reset') return clean(el.value || 'Submit');
    const near = /^(INPUT|SELECT|TEXTAREA)$/.test(tag) ? nearbyText(el) : '';
    if (el.placeholder) return clean(near && !el.placeholder.toLowerCase().includes(near.toLowerCase()) ? `${near} (${el.placeholder})` : el.placeholder);
    if (el.title) return clean(el.title);
    if (near) return near;
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

  const isAriaRadio = (el) => el.getAttribute && el.getAttribute('role') === 'radio' && el.tagName !== 'INPUT';
  function radiosOf(el) {
    if (isAriaRadio(el) || (el.getAttribute && el.getAttribute('role') === 'radiogroup')) {
      const box = el.getAttribute('role') === 'radiogroup' ? el : el.closest('[role="radiogroup"]') || el.parentElement?.parentElement || el.parentElement;
      const list = box ? [...box.querySelectorAll('[role="radio"]')] : [];
      return list.length ? list : [el];
    }
    if (el.name) {
      const scope = el.form || (el.getRootNode ? el.getRootNode() : document);
      const list = [...scope.querySelectorAll(`input[type="radio"][name="${CSS.escape(el.name)}"]`)];
      return list.length ? list : [el];
    }
    // radios without a name: group the ones that share the nearest fieldset / radiogroup / form row
    const box = el.closest('fieldset, [role="radiogroup"]') || el.parentElement?.parentElement?.parentElement || el.parentElement;
    const list = box ? [...box.querySelectorAll('input[type="radio"]')].filter((r) => !r.name) : [];
    return list.length ? list : [el];
  }
  const radioChecked = (r) => (isAriaRadio(r) ? r.getAttribute('aria-checked') === 'true' : r.checked);
  function radioOptionLabel(r) {
    if (isAriaRadio(r)) {
      const by = r.getAttribute('aria-labelledby');
      return clean(r.getAttribute('aria-label') || (by && textOf(byIdIn(r, by.split(/\s+/)[0]))) || textOf(r) || r.getAttribute('data-value') || '', 80);
    }
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
      const by = rg.getAttribute('aria-labelledby');
      const t = rg.getAttribute('aria-label') || (by && clean(by.split(/\s+/).map((id) => textOf(byIdIn(rg, id))).join(' ')));
      if (t) return clean(t);
    }
    // smallest container holding all radios of the group
    let p = first.parentElement;
    while (p && radios.some((r) => !p.contains(r))) p = p.parentElement;
    if (p) {
      const prev = p.previousElementSibling;
      if (prev && textOf(prev) && textOf(prev).length < 80) return textOf(prev);
      const head = p.firstElementChild;
      if (head && !head.querySelector('input, [role="radio"]') && !head.matches('input,label') && textOf(head) && textOf(head).length < 120) return textOf(head);
    }
    return humanize(first.name || first.id) || 'Options';
  }

  // ---------- snapshot ----------
  const SELECTOR = [
    'input', 'textarea', 'select', 'button', 'a[href]', 'summary', 'video', 'audio',
    '[role="button"]', '[role="link"]', '[role="checkbox"]', '[role="switch"]', '[role="tab"]',
    '[role="menuitem"]', '[role="option"]', '[role="combobox"]', '[role="searchbox"]', '[role="textbox"]',
    '[role="radio"]', '[role="menuitemcheckbox"]', '[role="menuitemradio"]', '[role="treeitem"]', '[role="spinbutton"]',
    '[contenteditable="true"]', '[contenteditable=""]', '[contenteditable="plaintext-only"]',
    // generic widgets that are clickable by script / keyboard but have no semantic role
    '[onclick]', '[tabindex="0"]', '[jsaction*="click"]', '[aria-haspopup]:not([aria-haspopup="false"])',
  ].join(', ');
  // things that make an element "a control" — used to skip wrappers that merely contain controls
  const CORE_SEL = 'input, textarea, select, button, a[href], [role="button"], [role="link"], [role="checkbox"], [role="radio"], [role="tab"], [role="menuitem"], [role="option"], [contenteditable="true"]';
  const MAX_ELEMENTS = 400, MAX_LINKS = 200;

  const registry = new Map(); // id → element (also finds elements inside shadow DOM)
  const prints = new Map();   // id → fingerprint, to find the element again after the site re-renders it
  function idOf(el) {
    if (!el.dataset.wpId) el.dataset.wpId = PREFIX + ++seq;
    registry.set(el.dataset.wpId, el);
    return el.dataset.wpId;
  }
  /** Cheap identity text for an element (no layout-heavy label search). */
  const quickName = (el) => clean(el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.getAttribute('name') ||
    (FIELD_TAGS.test(el.tagName) ? '' : el.textContent) || el.getAttribute('title') || el.getAttribute('value') || '', 60).toLowerCase();
  function remember(id, el, label) {
    const r = el.getBoundingClientRect();
    prints.set(id, { tag: el.tagName, role: el.getAttribute('role') || '', type: el.getAttribute('type') || '', name: el.getAttribute('name') || '',
      elId: el.id || '', q: quickName(el), label: (label || '').toLowerCase(), x: r.left + scrollX, y: r.top + scrollY });
  }
  /** The site replaced the element (React/Vue re-render): find the same control again by its fingerprint. */
  function refind(id) {
    const f = prints.get(id);
    if (!f) return null;
    let best = null, bestScore = 0;
    let n = 0;
    for (const el of deepAll(f.tag.toLowerCase())) {
      if (++n > 3000) break;
      if ((el.getAttribute('role') || '') !== f.role || (el.getAttribute('type') || '') !== f.type) continue;
      let s = 0;
      if (f.elId && el.id === f.elId) s += 6;
      if (f.name && el.getAttribute('name') === f.name) s += 5;
      if (f.q && quickName(el) === f.q) s += 5;
      if (!s && f.label) { try { if ((ownLabel(el) || '').toLowerCase() === f.label) s += 5; } catch {} }
      if (!s) continue;
      const r = el.getBoundingClientRect();
      s -= Math.min(Math.hypot(r.left + scrollX - f.x, r.top + scrollY - f.y) / 300, 3);
      if (s > bestScore && isVisible(el)) { bestScore = s; best = el; }
    }
    if (best && bestScore >= 4) { registry.set(id, best); return best; }
    return null;
  }
  function byWpId(id) {
    if (!id) return null;
    const el = registry.get(id);
    if (el && el.isConnected) return el;
    return document.querySelector(`[data-wp-id="${CSS.escape(id)}"]`) || refind(id);
  }

  /** querySelectorAll that also looks inside open shadow roots (web-component sites). */
  function deepAll(selector) {
    const out = [...document.querySelectorAll(selector)];
    const walk = (root) => {
      const tw = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
      let n;
      while ((n = tw.nextNode())) {
        if (n.shadowRoot) {
          out.push(...n.shadowRoot.querySelectorAll(selector));
          walk(n.shadowRoot);
        }
      }
    };
    walk(document.documentElement);
    return out;
  }

  function inViewport(el) {
    const r = el.getBoundingClientRect();
    return r.bottom > 0 && r.right > 0 && r.top < innerHeight && r.left < innerWidth;
  }

  /** The open modal / popup that is covering the page, if any. */
  function overlayRoot() {
    const explicit = [...document.querySelectorAll('dialog[open], [role="dialog"], [role="alertdialog"], [aria-modal="true"]')]
      .filter((d) => isVisible(d) && inViewport(d));
    if (explicit.length) return explicit[explicit.length - 1];
    // Probe a few points: a popup may not cover the exact centre (bottom sheets, side panels, offset modals).
    for (const [fx, fy] of [[0.5, 0.5], [0.5, 0.35], [0.5, 0.7], [0.3, 0.5], [0.7, 0.5]]) {
      let el = document.elementFromPoint(innerWidth * fx, innerHeight * fy);
      while (el && el !== document.body && el !== document.documentElement) {
        if (el.id === '__webpilot_overlay' || el.id === '__webpilot_marks') break;
        const s = getComputedStyle(el);
        if ((s.position === 'fixed' || s.position === 'sticky') && (parseInt(s.zIndex, 10) || 0) > 0) {
          const r = el.getBoundingClientRect();
          // big enough to be a popup (not a small toast or a header), and it has something in it
          if (r.width * r.height > innerWidth * innerHeight * 0.12 && r.height > innerHeight * 0.2 && (el.innerText || '').trim()) return el;
        }
        el = el.parentElement;
      }
    }
    return null;
  }

  /** Name for icon-only controls (×, search, menu…) that have no text. */
  function iconLabel(el) {
    const t = (el.textContent || '').trim();
    if (/^[×✕✖╳xX]$/.test(t)) return 'Close (×)';
    const use = el.querySelector && el.querySelector('use');
    const img = el.querySelector && el.querySelector('img');
    const hay = [el.getAttribute('aria-label'), el.title, el.getAttribute('alt'), el.getAttribute('data-testid'), el.getAttribute('data-cy'),
      el.getAttribute('data-test'), el.id, typeof el.className === 'string' ? el.className : el.getAttribute('class'),
      el.querySelector && el.querySelector('svg title')?.textContent, use && (use.getAttribute('href') || use.getAttribute('xlink:href')),
      img && img.getAttribute('alt'), img && img.getAttribute('src')].filter(Boolean).join(' ').toLowerCase();
    if (/close|cross|dismiss|btn-close|icon-x\b|\btimes\b|cancel-icon/.test(hay)) return 'Close (×)';
    if (/search/.test(hay)) return 'Search (icon)';
    if (/swap|exchange|interchange/.test(hay)) return 'Swap (icon)';
    if (/calendar|datepicker/.test(hay)) return 'Calendar (icon)';
    if (/hamburger|menu/.test(hay)) return 'Menu (icon)';
    if (/datepicker-next|chevron-right|arrow-right|\bnext\b/.test(hay)) return 'Next (icon)';
    if (/datepicker-prev|chevron-left|\bprev(ious)?\b/.test(hay)) return 'Previous (icon)';
    if (/arrow-left|\bback\b/.test(hay)) return 'Back (icon)';
    return '';
  }

  /** Date input (native or a datepicker widget). Returns the format hint, if any. */
  function dateField(el) {
    if (el.type === 'date') return 'yyyy-mm-dd';
    const hay = `${el.placeholder || ''} ${el.name || ''} ${el.id || ''} ${el.getAttribute('aria-label') || ''}`;
    const widget = el.closest('p-calendar, mat-datepicker, [class*="datepicker" i], [class*="calendar" i], [class*="date-picker" i]');
    if (!widget && !/\b(dd|mm|yyyy|date|dob)\b|date/i.test(hay)) return '';
    const fmt = (hay.match(/(dd|mm|yyyy)[\/\-.](dd|mm|yyyy)[\/\-.](dd|mm|yyyy)/i) || [])[0];
    const v = el.value || '';
    return fmt || (/^\d{2}\/\d{2}\/\d{4}$/.test(v) ? 'dd/mm/yyyy' : /^\d{4}-\d{2}-\d{2}$/.test(v) ? 'yyyy-mm-dd' : 'as shown');
  }

  /** Is this input an autocomplete / combobox (suggestions appear while typing)? */
  function isCombo(el) {
    const cls = typeof el.className === 'string' ? el.className : '';
    const wrap = el.closest('[class*="autocomplete" i], [class*="typeahead" i], [class*="combobox" i], [role="combobox"]');
    return el.getAttribute('role') === 'combobox' || !!el.getAttribute('aria-autocomplete') || /listbox|true/.test(el.getAttribute('aria-haspopup') || '') ||
      /autocomplete|typeahead|suggest|combo/i.test(cls) || !!wrap;
  }

  /** A control's own name: its text for buttons / clickable boxes, its label for fields. */
  function ownLabel(el) {
    if (/^(INPUT|SELECT|TEXTAREA)$/.test(el.tagName)) return labelFor(el);
    const aria = el.getAttribute('aria-label') || '';
    const okAria = aria && !/SafeValue|binding|<\/?[a-z]|\{\{/i.test(aria) && aria.length <= 80 ? aria : '';
    const own = clean(okAria || el.innerText || el.textContent || '', 60);
    return own || iconLabel(el) || labelFor(el);
  }

  function describe(el, overlay) {
    const tag = el.tagName.toLowerCase();
    const type = (el.getAttribute('type') || '').toLowerCase();
    const role = el.getAttribute('role');
    let invalid = el.getAttribute('aria-invalid') === 'true';
    try { invalid = invalid || el.matches(':user-invalid'); } catch {}
    const base = {
      name: (typeof el.name === 'string' && el.name) || undefined,
      required: el.required || el.getAttribute('aria-required') === 'true' || undefined,
      invalid: invalid || undefined,
      popup: overlay && deepContains(overlay, el) ? true : undefined,
      offscreen: inViewport(el) ? undefined : true,
      region: regionOf(el),
    };
    if (tag === 'video' || tag === 'audio') {
      return {
        id: idOf(el), kind: 'media', label: el.getAttribute('aria-label') || el.title || tag, ...base,
        playing: !el.paused && !el.ended && el.readyState > 2, paused: el.paused,
        time: Math.round(el.currentTime || 0), duration: Math.round(el.duration || 0) || undefined,
      };
    }
    if (type === 'checkbox' || ['checkbox', 'switch', 'menuitemcheckbox', 'menuitemradio'].includes(role)) {
      const checked = type === 'checkbox' ? el.checked : el.getAttribute('aria-checked') === 'true';
      const label = tag === 'input' ? labelFor(el) : ownLabel(el);
      if (!label) return null;
      return { id: idOf(el), kind: 'checkbox', label, checked, ...base };
    }
    if (role === 'spinbutton' && tag !== 'input') {
      return { id: idOf(el), kind: 'text', inputType: 'number', label: labelFor(el), value: clean(el.getAttribute('aria-valuenow') || textOf(el), 40), ...base };
    }
    if (tag === 'select') {
      const opts = [...el.options];
      const sel = opts[el.selectedIndex];
      const empty = !sel || sel.value === '' || /^(select|choose|--|please)/i.test(sel.text.trim());
      return {
        id: idOf(el), kind: 'select', label: labelFor(el), ...base,
        options: opts.filter((o) => o.value !== '').map((o) => clean(o.text, 60)).slice(0, 60),
        value: sel && !empty ? clean(sel.text, 60) : '', empty,
      };
    }
    if (tag === 'a' || role === 'link') {
      const label = labelFor(el) || iconLabel(el) || clean(el.querySelector('img[alt]')?.alt || '', 60);
      if (!label) return null;
      // SVG <a> elements have an SVGAnimatedString .href, not a string
      const href = (typeof el.href === 'string' && el.href) || el.getAttribute('href') || el.getAttribute('xlink:href') || '';
      return { id: idOf(el), kind: 'link', label, href: clean(href, 120) || undefined, pdf: /\.pdf(\?|#|$)/i.test(href) || undefined, ...base };
    }
    if (tag === 'button' || tag === 'summary' || (tag === 'input' && ['submit', 'button', 'reset', 'image'].includes(type)) ||
        ['button', 'tab', 'menuitem', 'option', 'treeitem'].includes(role) || (role === 'combobox' && tag !== 'input')) {
      const label = labelFor(el) || iconLabel(el);
      if (!label) return null;
      return { id: idOf(el), kind: 'button', label, buttonType: type || (tag === 'button' ? 'submit' : role || undefined), ...base };
    }
    if ((el.isContentEditable || role === 'textbox' || role === 'searchbox') && tag !== 'input' && tag !== 'textarea') {
      const v = textOf(el);
      return { id: idOf(el), kind: 'editable', label: labelFor(el), value: v, empty: !v, ...base };
    }
    if (tag === 'textarea' || tag === 'input') {
      if (['file', 'range', 'color', 'hidden'].includes(type)) return null;
      const secret = type === 'password';
      return {
        id: idOf(el), kind: tag === 'textarea' ? 'textarea' : 'text', inputType: type || 'text',
        label: labelFor(el), placeholder: clean(el.placeholder, 60) || undefined,
        autocomplete: el.getAttribute('autocomplete') || undefined, combo: isCombo(el) || undefined, date: dateField(el) || undefined, ...base,
        value: secret ? (el.value ? '••••' : '') : clean(el.value, 80), empty: !el.value,
      };
    }
    // Generic script-driven widgets (<div onclick>, tabindex="0", jsaction, aria-haspopup): a button, unless it is
    // just a wrapper around real controls or a big content region.
    if (!/^(INPUT|SELECT|TEXTAREA|BUTTON|A|VIDEO|AUDIO|BODY|HTML|MAIN|FORM|IFRAME)$/.test(el.tagName)) {
      if (el.querySelector(CORE_SEL)) return null;
      const r = el.getBoundingClientRect();
      if (r.width * r.height > innerWidth * innerHeight * 0.3) return null;
      const label = ownLabel(el);
      if (!label || label.length > 100) return null;
      return { id: idOf(el), kind: 'button', label: clean(label, 80), buttonType: 'clickable', ...base };
    }
    return null;
  }

  /** Which page region an element sits in (navigation / footer links are rarely what a task needs). */
  function regionOf(el) {
    const r = deepClosest(el, 'nav, footer, header, aside, [role="navigation"], [role="contentinfo"], [role="banner"], [role="complementary"]');
    if (!r) return undefined;
    const t = r.tagName.toLowerCase(), role = r.getAttribute('role');
    return t === 'footer' || role === 'contentinfo' ? 'footer' : t === 'header' || role === 'banner' ? 'header' : t === 'aside' || role === 'complementary' ? 'aside' : 'nav';
  }

  // ---------- code editors ----------
  const EDITOR_SEL = '.monaco-editor, .cm-editor, .CodeMirror, .ace_editor, [data-code-editor]';
  const editorType = (el) => (el.matches('.monaco-editor') ? 'monaco' : el.matches('.cm-editor') ? 'codemirror6'
    : el.matches('.CodeMirror') ? 'codemirror5' : el.matches('.ace_editor') ? 'ace' : 'editor');

  function findEditors() {
    return deepAll(EDITOR_SEL).filter((e) => isVisible(e) && !(e.parentElement && e.parentElement.closest(EDITOR_SEL)));
  }

  /** Best-effort code text from the DOM (the side panel refines this through the editor's own API). */
  function editorText(el) {
    const t = editorType(el);
    const lines = (sel) => [...el.querySelectorAll(sel)].map((n) => n.textContent.replace(/ /g, ' ')).join('\n');
    if (t === 'monaco') return lines('.view-line');
    if (t === 'codemirror6') return (el.querySelector('.cm-content') || el).innerText;
    if (t === 'codemirror5') return lines('.CodeMirror-line');
    if (t === 'ace') return lines('.ace_line');
    const ta = el.querySelector('textarea');
    return ta ? ta.value : el.innerText;
  }

  const RESULT_RE = /(accepted|wrong answer|runtime error|compil(e|ation) error|time limit|memory limit|passed\s*\d+\s*\/\s*\d+|\d+\s*\/\s*\d+\s*(test|passed)|test cases? passed|all test|failing at|failing test|failed test|test( case)? #?\d+|expected output|your output|segmentation fault|exception|traceback|syntax error|success)/i;

  /** Short visible text blocks that look like a judge's verdict / test output. */
  function resultText(editors) {
    const blocks = [];
    for (const n of document.querySelectorAll('div, section, p, span, pre, h1, h2, h3, h4')) {
      if (blocks.length > 40) break;
      if (editors.some((ed) => ed.contains(n))) continue;
      const t = (n.innerText || '').trim();
      if (t.length < 6 || t.length > 400 || !RESULT_RE.test(t) || !isVisible(n)) continue;
      blocks.push(t.replace(/\s+/g, ' '));
    }
    // keep the most specific blocks (drop ones that contain another kept block)
    const uniq = [...new Set(blocks)].sort((a, b) => a.length - b.length);
    const kept = [];
    for (const b of uniq) if (!kept.some((k) => b.includes(k))) kept.push(b);
    return kept.join(' | ').slice(0, 900);
  }

  function pointerClickables(listed, editors) {
    const out = [];
    let checked = 0;
    for (const el of document.querySelectorAll('a:not([href]), div, span, li, td, th, label, img, svg, i, p, h1, h2, h3, h4, h5, h6, section, article')) {
      if (out.length >= 100 || ++checked > 6000) break;
      if (listed.has(el)) continue;
      { const r = el.getBoundingClientRect(); if (r.bottom <= 0 || r.right <= 0 || r.left >= innerWidth || r.top >= innerHeight * 1.6) continue; }
      if (el.closest('a[href], button, [role="button"], [role="link"], input, select, textarea, #__webpilot_overlay, #__webpilot_marks')) continue;
      if (editors.some((ed) => ed.contains(el))) continue;
      if (getComputedStyle(el).cursor !== 'pointer') continue;
      const p = el.parentElement;
      if (p && getComputedStyle(p).cursor === 'pointer') continue; // only the outermost clickable box
      if (!isVisible(el) || el.querySelector('a[href], button, input, select, textarea')) continue;
      out.push(el);
    }
    return out;
  }

  /**
   * Wait until the page stops adding / removing elements (SPAs render after "load"), so the snapshot
   * doesn't describe a half-built page. Text-only updates (clocks, counters) don't count.
   */
  function waitForStable({ quiet = 280, max = 2500 } = {}) {
    return new Promise((resolve) => {
      const start = performance.now();
      let last = start, sawChange = false;
      let mo = null;
      try {
        mo = new MutationObserver((recs) => {
          for (const r of recs) {
            if (isOurs(r.target)) continue;
            for (const n of r.addedNodes) if (n.nodeType === 1 && !isOurs(n)) { last = performance.now(); sawChange = true; return; }
            for (const n of r.removedNodes) if (n.nodeType === 1) { last = performance.now(); sawChange = true; return; }
          }
        });
        mo.observe(document.documentElement, { childList: true, subtree: true });
      } catch {}
      const tick = () => {
        const now = performance.now();
        const calm = now - last >= (sawChange ? quiet : 120);
        if ((calm && document.readyState !== 'loading') || now - start >= max) { mo && mo.disconnect(); resolve(); } else setTimeout(tick, 50);
      };
      setTimeout(tick, 50);
    });
  }

  /** Where a real click on an element would land, and what (if anything) sits on top of that point. */
  function hitTest(el, overlay = overlayRoot()) {
    const target = (el.type === 'checkbox' || el.type === 'radio') && el.labels?.[0] && !isVisible(el) ? el.labels[0] : el;
    const r = target.getBoundingClientRect();
    if (!r.width || !r.height) return { target, x: r.left, y: r.top, top: null, covered: false };
    // try the centre first, then a few other points of the element (a badge / icon may cover just the middle)
    const pts = [[0.5, 0.5], [0.25, 0.5], [0.75, 0.5], [0.5, 0.25], [0.5, 0.75], [0.15, 0.2], [0.85, 0.8]];
    let firstTop = null;
    for (const [fx, fy] of pts) {
      const x = Math.round(r.left + r.width * fx), y = Math.round(r.top + r.height * fy);
      if (x < 0 || y < 0 || x >= innerWidth || y >= innerHeight) continue;
      const top = deepElementFromPoint(x, y);
      if (!top || isOurs(top)) return { target, x, y, top: null, covered: false };
      if (top === target || deepContains(target, top) || deepContains(top, target) ||
          (el.labels && [...el.labels].some((l) => deepContains(l, top))) || sameWidget(target, top, overlay)) {
        return { target, x, y, top: null, covered: false };
      }
      firstTop = firstTop || top;
    }
    const x = Math.round(r.left + r.width / 2), y = Math.round(r.top + r.height / 2);
    return { target, x, y, top: firstTop, covered: !!firstTop };
  }
  /** Decorations of the same control (floating labels, icon overlays, ripple layers) aren't "covering" it. */
  function sameWidget(a, b, overlay) {
    if (overlay && deepContains(overlay, b) && !deepContains(overlay, a)) return false;
    let p = composedParent(a);
    for (let i = 0; p && i < 3 && p !== document.body; i++, p = composedParent(p)) {
      if (deepContains(p, b)) {
        const r = p.getBoundingClientRect();
        return r.width * r.height < innerWidth * innerHeight * 0.25; // a small shared box, not a whole page section
      }
    }
    return false;
  }

  async function snapshot({ settle = true } = {}) {
    if (settle) await waitForStable();
    const t0 = performance.now();
    const overBudget = () => performance.now() - t0 > 2500; // never let a giant page freeze the agent
    const overlay = overlayRoot();
    const editors = findEditors();
    const items = [];
    const seenRadios = new Set();
    const popupOf = (el) => (overlay && deepContains(overlay, el) ? true : undefined);
    for (const el of deepAll(SELECTOR)) {
      try {
        if (el.disabled) continue;
        if (isOurs(el) || el.getAttribute('type') === 'hidden') continue;
        if (editors.length && editors.some((ed) => ed.contains(el))) continue; // the editor is listed as one element
        const isMedia = el.tagName === 'VIDEO' || el.tagName === 'AUDIO';
        if (!isMedia && !isUsable(el)) continue;
        if (isMedia && !isVisible(el) && !(el.currentTime > 0)) continue;
        if (el.type === 'radio' || isAriaRadio(el)) {
          if (seenRadios.has(el)) continue;
          const radios = radiosOf(el);
          radios.forEach((r) => seenRadios.add(r));
          const checked = radios.find(radioChecked);
          items.push({
            id: idOf(radios[0]), kind: 'radio-group', label: radioGroupLabel(radios),
            popup: popupOf(el), offscreen: inViewport(el) ? undefined : true, region: regionOf(el),
            required: radios.some((r) => r.required || r.getAttribute('aria-required') === 'true') || undefined,
            options: radios.map(radioOptionLabel).slice(0, 40), value: checked ? radioOptionLabel(checked) : '', empty: !checked,
          });
          continue;
        }
        const d = describe(el, overlay);
        if (d) items.push(d);
      } catch { /* one odd element must never break the whole snapshot */ }
      if (items.length > 1500 || overBudget()) break;
    }
    // Custom widgets: elements that look clickable (pointer cursor) but aren't buttons or links.
    const listed = new Set(items.map((i) => registry.get(i.id)));
    if (!overBudget()) {
      for (const el of pointerClickables(listed, editors)) {
        try {
          const label = clean(el.getAttribute('aria-label') || el.title || el.innerText || el.getAttribute('alt') || el.querySelector('img')?.alt || '', 70) || iconLabel(el);
          if (label) items.push({ id: idOf(el), kind: 'button', label, buttonType: 'clickable', popup: popupOf(el), offscreen: inViewport(el) ? undefined : true, region: regionOf(el) });
        } catch {}
      }
    }
    // Something drawn on top of an element (a popup / overlay) would swallow a real click.
    let probed = 0;
    for (const it of items) {
      if (it.offscreen || it.kind === 'media' || it.kind === 'code-editor' || ++probed > 200) continue;
      try { if (hitTest(registry.get(it.id), overlay).covered) it.covered = true; } catch {}
    }
    // Priority: popup first, then what's on screen, then the rest of the page.
    for (const ed of editors) {
      const code = editorText(ed);
      items.unshift({ id: idOf(ed), kind: 'code-editor', label: `Code editor (${editorType(ed)})`, editorType: editorType(ed), value: code.slice(0, 6000), lines: code.split('\n').length });
    }
    // Repeated labels ("Book Now", "Refresh", "Select" on every result card) are useless to the AI on their own:
    // add the tile's own text and the card's title, e.g. "AC 3 Tier (3A) Refresh · GOLDEN TEMPLE M (12904)".
    const counts = {};
    for (const it of items) if (it.kind === 'button' || it.kind === 'link') counts[it.label] = (counts[it.label] || 0) + 1;
    const clickSet = new Set(items.filter((i) => i.kind === 'button' || i.kind === 'link').map((i) => registry.get(i.id)).filter(Boolean));
    // on-screen ones first; capped so huge result lists can't stall the snapshot
    const dups = items.filter((it) => (it.kind === 'button' || it.kind === 'link') && counts[it.label] >= 2 && it.label.length <= 40 && registry.get(it.id))
      .sort((a, b) => (a.offscreen ? 1 : 0) - (b.offscreen ? 1 : 0)).slice(0, 120);
    /** Does box p contain another listed control besides el? */
    const holdsOther = (p, el) => {
      for (const n of p.querySelectorAll('[data-wp-id]')) if (n !== el && !el.contains(n) && clickSet.has(n)) return true;
      return false;
    };
    // pass 1: each repeated control's own tile text ("AC 3 Tier (3A) Refresh")
    for (const it of dups) {
      it._tile = '';
      if (overBudget()) continue;
      const el = registry.get(it.id);
      try {
        for (let p = el.parentElement, i = 0; p && i < 4; p = p.parentElement, i++) {
          if (holdsOther(p, el)) break; // would swallow neighbouring buttons
          const t = clean(p.innerText || '', 120);
          if (t.length > it.label.length + 2) { if (t.length <= 70) it._tile = t; break; }
        }
      } catch {}
    }
    const tileTexts = dups.map((d) => d._tile).filter(Boolean);
    // pass 2: the card's title — a heading that isn't simply another tile's text ("GOLDEN TEMPLE M (12904)")
    for (const it of dups) {
      const el = registry.get(it.id);
      let title = '';
      try {
        for (let p = el.parentElement, i = 0; p && i < 9 && p !== document.body && !title && !overBudget(); p = p.parentElement, i++) {
          let looked = 0;
          for (const h of p.querySelectorAll('h1, h2, h3, h4, h5, h6, strong, b, [class*="title" i], [class*="name" i], [class*="heading" i]')) {
            if (++looked > 25) break;
            if (h.contains(el) || h.closest('[data-wp-id]') && clickSet.has(h.closest('[data-wp-id]')) && h.closest('[data-wp-id]') !== el) continue;
            const ht = clean(h.innerText || '', 60);
            if (!ht || ht.length <= 2 || it._tile.includes(ht) || it.label.includes(ht)) continue;
            if (tileTexts.some((t) => t.startsWith(ht))) continue; // heading of a sibling tile
            title = ht;
            break;
          }
        }
      } catch {}
      const ctx = [it._tile && it._tile !== it.label ? it._tile : it.label, title].filter(Boolean).join(' · ');
      if (ctx !== it.label) it.label = clean(ctx, 110);
      delete it._tile;
    }

    // Custom dropdowns (PrimeNG p-dropdown, MUI selects…) show only their current value — add the field's name.
    for (const it of items) {
      if (it.kind !== 'button') continue;
      if (overBudget()) break;
      const el = registry.get(it.id);
      const dd = el && el.closest('p-dropdown, mat-select, [class*="dropdown" i], [class*="select" i]:not([class*="selected" i]):not([class*="selection" i]), [role="combobox"], [aria-haspopup="listbox"]');
      if (!dd || dd.closest('nav, header') || dd.querySelector('a[href]')) continue;
      // the name usually sits on a wrapper a few levels up (e.g. <p-dropdown arialabel="Select Journey Class">)
      let name = '';
      for (let n = dd, i = 0; n && i < 5 && !name; n = n.parentElement, i++) {
        name = n.getAttribute('aria-label') || n.getAttribute('arialabel') || n.getAttribute('placeholder') ||
          humanize(n.getAttribute('formcontrolname') || n.getAttribute('name') || '');
      }
      name = name || nearbyText(el);
      name = clean(String(name).replace(/^select\s+/i, ''), 40);
      if (name && !it.label.toLowerCase().includes(name.toLowerCase())) it.label = clean(`${name}: ${it.label}`, 80);
      it.combo = true; // open it and pick with `choose`
    }
    // popup first, then the main content on screen, then on-screen nav/header, then the rest of the page (footer last)
    const rank = (e) => (e.kind === 'code-editor' ? -1 : e.popup ? 0 : !e.offscreen ? (e.region === 'footer' || e.region === 'nav' && e.kind === 'link' ? 1.5 : 1)
      : e.region === 'footer' || e.region === 'nav' || e.region === 'aside' ? 3 : 2);
    const ordered = items.map((e, i) => [e, i]).sort((a, b) => rank(a[0]) - rank(b[0]) || a[1] - b[1]).map((x) => x[0]);
    const out = [];
    let links = 0;
    for (const e of ordered) {
      if (e.kind === 'link' && ++links > MAX_LINKS) continue;
      out.push(e);
      if (out.length >= MAX_ELEMENTS) break;
    }
    for (const e of out) { const el = registry.get(e.id); if (el) try { remember(e.id, el, e.kind === 'radio-group' ? '' : e.label); } catch {} }

    const headings = [...document.querySelectorAll('h1, h2, h3, legend')]
      .filter((h) => isVisible(h) && inViewport(h)).map((h) => textOf(h)).filter(Boolean).slice(0, 8);
    const errors = [...document.querySelectorAll('[role="alert"], [aria-live="assertive"], .error, .errors, .invalid-feedback, .field-error, [class*="error-message"], [class*="errorMessage"]')]
      .filter(isVisible).map((n) => textOf(n)).filter((t) => t && t.length < 200);
    // Toasts / live regions: the site's own confirmation that an action worked ("Message sent", "Saved").
    const ERR_RE = /error|invalid|failed|incorrect|required|not available|wrong|unable|denied|try again|couldn'?t|could not/i;
    const live = [...document.querySelectorAll('[role="status"], [role="alert"], [aria-live="polite"], [aria-live="assertive"], [class*="toast" i], [class*="snackbar" i], .bAq')]
      .filter((n) => !isOurs(n) && isVisible(n)).map((n) => textOf(n)).filter((t) => t && t.length < 160);
    const notices = [...new Set(live.filter((t) => !ERR_RE.test(t)))].slice(0, 6);
    const realErrors = errors.filter((t) => !notices.includes(t));
    const main = document.querySelector('main, [role="main"]') || document.body;
    // WebPilot never solves CAPTCHAs: scrub CAPTCHA text (and what the user typed into it) from everything sent to the AI.
    const captchas = [...document.querySelectorAll('[class*="captcha" i], [id*="captcha" i], [name*="captcha" i]')]
      .map((n) => (n.tagName === 'INPUT' ? n.value : n.innerText || '').trim())
      .filter((t) => t.length >= 3 && t.length <= 24);
    const scrub = (t) => captchas.reduce((o, c) => o.split(c).join('[captcha]'), t || '');
    if (captchas.length) for (const e of out) { e.label = scrub(e.label); if (typeof e.value === 'string') e.value = scrub(e.value); }
    return {
      url: location.href,
      title: document.title,
      isPdf: document.contentType === 'application/pdf',
      headings: headings.map(scrub),
      popupText: overlay ? scrub(clean(overlay.innerText, 400)) : '',
      errors: [...new Set(realErrors)].slice(0, 6).map(scrub),
      notices: notices.map(scrub),
      // coding pages need the whole problem statement
      text: scrub(clean(main ? main.innerText : '', editors.length ? 4000 : 1500)),
      results: editors.length ? resultText(editors) : '',
      scroll: { atTop: scrollY < 50, atBottom: innerHeight + scrollY >= document.documentElement.scrollHeight - 50 },
      elements: out,
      frame: { top: window === window.top, url: location.href, w: innerWidth, h: innerHeight },
      ms: Math.round(performance.now() - t0),
    };
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
        const wt = w.split(' ').filter((x) => !STOP.has(x)), tt = new Set(t.split(' '));
        const nums = wt.filter((x) => /\d/.test(x));
        const hit = wt.filter((x) => tt.has(x)).length;
        if (nums.length && !nums.every((x) => tt.has(x))) s = 0; // a different number/code = a different option
        else if (hit < Math.ceil(wt.length * 0.6)) s = 0; // most of the wanted words must be there
        else s = (60 * hit) / Math.max(wt.length, tt.size);
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

  // ---------- highlight ring (which element is being acted on) ----------
  let overlayTimer;
  function highlight(el, text) {
    let box = document.getElementById('__webpilot_overlay');
    if (!box) {
      box = document.createElement('div');
      box.id = '__webpilot_overlay';
      Object.assign(box.style, {
        position: 'fixed', zIndex: 2147483646, pointerEvents: 'none', borderRadius: '7px',
        border: '1.5px solid rgba(124,108,240,.95)', boxShadow: '0 0 0 3px rgba(124,108,240,.16)',
        transition: 'top .22s ease, left .22s ease, width .22s ease, height .22s ease, opacity .25s ease', opacity: '0',
      });
      document.documentElement.appendChild(box);
    }
    const target = el.type === 'checkbox' || el.type === 'radio' ? (el.labels && el.labels[0]) || el : el;
    const r = target.getBoundingClientRect();
    Object.assign(box.style, { display: 'block', opacity: '1', top: `${r.top - 3}px`, left: `${r.left - 3}px`, width: `${r.width + 6}px`, height: `${r.height + 6}px` });
    box.dataset.label = text || '';
    clearTimeout(overlayTimer);
    overlayTimer = setTimeout(() => { box.style.opacity = '0'; }, 1400);
  }

  // ---------- agent cursor: shows exactly where WebPilot's real clicks and typing land ----------
  // It only ever moves to the coordinates of the action that is about to run, so it can't drift from reality.
  let cur = null, curPos = null, curHideTimer = null;
  const SVGNS = 'http://www.w3.org/2000/svg';
  function cursorEl() {
    if (cur && cur.isConnected) return cur;
    cur = document.createElement('div');
    cur.id = '__webpilot_cursor';
    Object.assign(cur.style, {
      position: 'fixed', left: '0', top: '0', zIndex: 2147483647, pointerEvents: 'none', opacity: '0',
      transition: 'transform .42s cubic-bezier(.22,.8,.24,1), opacity .25s ease', willChange: 'transform',
    });
    const svg = document.createElementNS(SVGNS, 'svg');
    svg.setAttribute('width', '22'); svg.setAttribute('height', '22'); svg.setAttribute('viewBox', '0 0 24 24');
    svg.style.cssText = 'display:block;filter:drop-shadow(0 2px 4px rgba(0,0,0,.35));transition:transform .12s ease;transform-origin:3px 3px';
    const path = document.createElementNS(SVGNS, 'path');
    path.setAttribute('d', 'M3.5 2.5 L19 11.6 L12.2 13.3 L8.6 19.8 Z');
    path.setAttribute('fill', '#15131f'); path.setAttribute('stroke', '#ffffff'); path.setAttribute('stroke-width', '1.6'); path.setAttribute('stroke-linejoin', 'round');
    svg.appendChild(path);
    const dot = document.createElementNS(SVGNS, 'circle');
    dot.setAttribute('cx', '15.5'); dot.setAttribute('cy', '17.5'); dot.setAttribute('r', '3.2');
    dot.setAttribute('fill', '#7c6cf0'); dot.setAttribute('stroke', '#ffffff'); dot.setAttribute('stroke-width', '1.2');
    svg.appendChild(dot);
    const ring = document.createElement('div');
    ring.className = 'wp-ring';
    Object.assign(ring.style, { position: 'absolute', left: '-11px', top: '-11px', width: '26px', height: '26px', borderRadius: '50%',
      border: '2px solid rgba(124,108,240,.9)', opacity: '0', pointerEvents: 'none' });
    const tag = document.createElement('div');
    tag.className = 'wp-tag';
    Object.assign(tag.style, {
      position: 'absolute', left: '20px', top: '20px', whiteSpace: 'nowrap', maxWidth: '260px', overflow: 'hidden', textOverflow: 'ellipsis',
      font: '500 11px/1.3 -apple-system, "Segoe UI", system-ui, sans-serif', letterSpacing: '.01em', color: '#f3f2f8',
      background: 'rgba(20,19,28,.86)', border: '1px solid rgba(255,255,255,.12)', borderRadius: '6px', padding: '3px 7px',
      backdropFilter: 'blur(8px)', webkitBackdropFilter: 'blur(8px)', opacity: '0', transition: 'opacity .2s ease',
    });
    cur.append(ring, svg, tag);
    document.documentElement.appendChild(cur);
    return cur;
  }
  function cursorTag(text) {
    const tag = cursorEl().querySelector('.wp-tag');
    tag.textContent = text || '';
    tag.style.opacity = text ? '1' : '0';
  }
  /** Glide to (x, y) in this frame's viewport; resolves when the cursor has arrived. */
  async function cursorMove(x, y, label, from) {
    const c = cursorEl();
    clearTimeout(curHideTimer);
    if (!curPos) {
      let start = from;
      try { start = start || JSON.parse(sessionStorage.getItem('__wpcur') || 'null'); } catch {}
      start = start || { x: Math.min(x + 140, innerWidth - 30), y: Math.min(y + 90, innerHeight - 30) };
      c.style.transition = 'none';
      c.style.transform = `translate3d(${start.x}px, ${start.y}px, 0)`;
      void c.offsetWidth;
      c.style.transition = 'transform .42s cubic-bezier(.22,.8,.24,1), opacity .25s ease';
      curPos = start;
    }
    c.style.opacity = '1';
    const dist = Math.hypot(x - curPos.x, y - curPos.y);
    const ms = Math.round(Math.min(Math.max(dist / 2.2, 160), 520));
    c.style.transitionDuration = `${ms}ms, .25s`;
    c.style.transform = `translate3d(${x}px, ${y}px, 0)`;
    curPos = { x, y };
    try { sessionStorage.setItem('__wpcur', JSON.stringify(curPos)); } catch {}
    cursorTag(label);
    await sleep(ms + 30);
  }
  function cursorClick() {
    const c = cursorEl();
    const svg = c.querySelector('svg'), ring = c.querySelector('.wp-ring');
    try {
      svg.animate([{ transform: 'scale(1)' }, { transform: 'scale(.82)' }, { transform: 'scale(1)' }], { duration: 220, easing: 'ease-out' });
      ring.animate([{ transform: 'scale(.4)', opacity: 0.95 }, { transform: 'scale(1.6)', opacity: 0 }], { duration: 480, easing: 'ease-out' });
    } catch {}
  }
  function cursorHide() {
    if (!cur) return;
    cursorTag('');
    curHideTimer = setTimeout(() => { if (cur) cur.style.opacity = '0'; }, 500);
  }
  /** In-page path: glide to an element's centre before acting on it. */
  async function cursorToEl(el, label) {
    try {
      const t = el.type === 'checkbox' || el.type === 'radio' ? (el.labels && el.labels[0]) || el : el;
      const r = t.getBoundingClientRect();
      if (!r.width || !r.height) return;
      // the element's centre — exactly where realClick() dispatches its pointer events
      await cursorMove(Math.round(r.left + r.width / 2), Math.round(r.top + r.height / 2), label);
    } catch {}
  }
  /** Type progressively (each chunk is a real input event), so the user sees the text appear. */
  async function typeProgressive(el, text) {
    const v = String(text);
    const steps = Math.min(40, Math.max(1, v.length));
    const size = Math.ceil(v.length / steps);
    if (el.isContentEditable && el.tagName !== 'INPUT' && el.tagName !== 'TEXTAREA') {
      document.execCommand('selectAll', false);
      if (!v) { document.execCommand('delete', false); return; }
      for (let i = 0; i < v.length; i += size) { document.execCommand('insertText', false, v.slice(i, i + size)); await sleep(16); }
      return;
    }
    const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
    if (!v) { setter.call(el, ''); el.dispatchEvent(new Event('input', { bubbles: true })); }
    for (let i = size; i < v.length + size; i += size) {
      setter.call(el, v.slice(0, Math.min(i, v.length)));
      el.dispatchEvent(new Event('input', { bubbles: true }));
      await sleep(16);
    }
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }

  // ---------- execute ----------
  function isPaymentOrOtp(el) {
    const ac = (el.getAttribute('autocomplete') || '').toLowerCase();
    return ac.startsWith('cc-') || ac === 'one-time-code' || /\b(otp|cvv|cvc|card number|captcha)\b/i.test(labelFor(el)) ||
      /captcha/i.test(`${el.name || ''} ${el.id || ''} ${el.placeholder || ''}`);
  }

  function realClick(el) {
    const r = el.getBoundingClientRect();
    const o = { bubbles: true, cancelable: true, composed: true, view: window, button: 0, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 };
    try {
      el.dispatchEvent(new PointerEvent('pointerdown', o));
      el.dispatchEvent(new MouseEvent('mousedown', o));
      if (el.focus) el.focus({ preventScroll: true });
      el.dispatchEvent(new PointerEvent('pointerup', o));
      el.dispatchEvent(new MouseEvent('mouseup', o));
    } catch {}
    el.click();
  }

  const KEYCODES = { Enter: 13, Escape: 27, Tab: 9, ArrowDown: 40, ArrowUp: 38, ' ': 32 };

  async function pressKey(el, key) {
    const init = { key, code: key === ' ' ? 'Space' : key, keyCode: KEYCODES[key] || 0, which: KEYCODES[key] || 0, bubbles: true, cancelable: true, composed: true };
    const target = el || document.activeElement || document.body;
    if (target.focus) target.focus();
    const notPrevented = target.dispatchEvent(new KeyboardEvent('keydown', init));
    target.dispatchEvent(new KeyboardEvent('keypress', init));
    target.dispatchEvent(new KeyboardEvent('keyup', init));
    if (key !== 'Enter' || !notPrevented) return;
    // Synthetic key events don't trigger the browser's default "submit on Enter", so do it explicitly.
    await sleep(150);
    if (!target.isConnected) return;
    const form = target.form || (target.closest && target.closest('form'));
    if (form) {
      if (form.requestSubmit) form.requestSubmit(); else form.submit();
      return;
    }
    const box = target.closest && target.closest('[role="search"], header, nav, div');
    const btn = box && box.querySelector('button[type="submit"], button[aria-label*="search" i], [role="button"][aria-label*="search" i], button[title*="search" i]');
    if (btn) realClick(btn);
  }

  const OPTION_SEL = [
    '[role="option"]', '[role="listbox"] li', '[role="menuitem"]', '[role="treeitem"]',
    'li[class*="option" i]', 'li[class*="item" i]', 'div[class*="option" i]', 'div[class*="item" i][class*="list" i]',
    '[class*="autocomplete" i] li', '[class*="suggest" i] li', '[class*="dropdown" i] li', '[class*="typeahead" i] li',
    'ul[class*="list" i] li', '[class*="menu" i] li', '.dropdown-item',
  ].join(', ');

  /** Visible suggestions/options, best match for "want" first (closest to the field wins ties). */
  function findOptions(want, nearId) {
    const near = byWpId(nearId);
    const nr = near ? near.getBoundingClientRect() : null;
    const scroller = (o) => {
      for (let p = o.parentElement, i = 0; p && i < 6; p = p.parentElement, i++) {
        const st = getComputedStyle(p);
        if (/(auto|scroll)/.test(st.overflowY) && p.scrollHeight > p.clientHeight + 4) return p;
      }
      return null;
    };
    const cands = deepAll(OPTION_SEL).filter((o) => {
      if (o === near || (near && o.contains(near)) || !isVisible(o) || o.closest('#__webpilot_marks, #__webpilot_overlay, nav, header')) return false;
      const t = textOf(o);
      if (!t || t.length >= 160) return false;
      const sc = scroller(o);
      return sc ? inViewport(sc) : inViewport(o); // inside a visible scrollable list = reachable
    });
    const leaves = cands.filter((o) => !cands.some((c) => c !== o && o.contains(c)));
    const opts = leaves.map((el) => {
      const r = el.getBoundingClientRect();
      const dist = nr ? Math.hypot(r.left - nr.left, r.top - nr.bottom) : 0;
      return { el, text: clean(el.innerText || el.textContent, 100), dist, r };
    }).sort((a, b) => a.dist - b.dist);
    const idx = bestOption(opts.map((o) => ({ text: o.text, value: o.text })), want);
    const best = idx >= 0 ? opts[idx] : null;
    if (best) {
      const sc = scroller(best.el);
      if (sc) {
        const cr = sc.getBoundingClientRect();
        if (best.r.top < cr.top || best.r.bottom > cr.bottom) sc.scrollTop += best.r.top - cr.top - cr.height / 2 + best.r.height / 2;
        best.r = best.el.getBoundingClientRect();
      }
      // still past the window edge (a long list opening near the bottom)? nudge the page just enough
      if (best.r.top < 0 || best.r.bottom > innerHeight) {
        best.el.scrollIntoView({ block: 'nearest', behavior: 'instant' });
        best.r = best.el.getBoundingClientRect();
      }
    }
    return {
      options: opts.slice(0, 12).map((o) => o.text),
      best: best ? { id: idOf(best.el), text: best.text, x: Math.round(best.r.left + Math.min(best.r.width / 2, 40)), y: Math.round(best.r.top + best.r.height / 2) } : null,
    };
  }

  /** Scroll an element into view and report where a real click should land. */
  async function locate(id, text) {
    const el = byWpId(id);
    if (!el) throw new Error('That element is no longer on the page (the page may have changed).');
    const pre = el.getBoundingClientRect();
    if (pre.top < 0 || pre.left < 0 || pre.bottom > innerHeight || pre.right > innerWidth) {
      el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
      await sleep(90);
    }
    let hit = hitTest(el);
    if (hit.covered) {
      // a sticky header / footer may hide it after scrolling — nudge it to the other part of the screen once
      el.scrollIntoView({ block: hit.y > innerHeight / 2 ? 'start' : 'end', behavior: 'instant' });
      scrollBy({ top: hit.y > innerHeight / 2 ? -innerHeight * 0.3 : innerHeight * 0.3, behavior: 'instant' });
      await sleep(90);
      const again = hitTest(el);
      if (!again.covered) hit = again; else { el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' }); await sleep(60); hit = hitTest(el); }
    }
    const top = hit.top;
    const label = el.type === 'radio' || isAriaRadio(el) ? radioGroupLabel(radiosOf(el)) : ownLabel(el);
    if (text) highlight(el, text);
    const r = hit.target.getBoundingClientRect();
    const coverName = (n) => clean(n.innerText || n.getAttribute('aria-label') || (typeof n.className === 'string' ? n.className : '') || n.tagName, 80);
    return {
      x: hit.x, y: hit.y, label: clean(label, 60),
      hidden: !r.width || !r.height || undefined,
      covered: hit.covered && top ? coverName(top) : '',
      tag: el.tagName.toLowerCase(), type: (el.getAttribute('type') || '').toLowerCase(),
      editable: el.isContentEditable || /^(INPUT|TEXTAREA)$/.test(el.tagName),
      readOnly: !!el.readOnly, isSelect: el.tagName === 'SELECT',
      checked: el.type === 'checkbox' || el.type === 'radio' ? el.checked : el.getAttribute('aria-checked') === 'true',
      focused: document.activeElement === el || deepContains(el, deepActive()),
      blocked: isPaymentOrOtp(el),
    };
  }
  /** document.activeElement, descending into shadow roots. */
  function deepActive() {
    let a = document.activeElement;
    while (a && a.shadowRoot && a.shadowRoot.activeElement) a = a.shadowRoot.activeElement;
    return a;
  }

  // ---------- frames: where this frame sits inside the top window (for real clicks in iframes) ----------
  // Works across origins: the child asks its parent with postMessage; the parent finds the <iframe> whose
  // contentWindow sent it, adds that iframe's position to its own offset, and answers.
  window.addEventListener('message', (ev) => {
    const d = ev.data;
    if (!d || typeof d !== 'object' || d.__wpOffsetReq == null || !ev.source) return;
    const fr = deepAll('iframe, frame').find((f) => { try { return f.contentWindow === ev.source; } catch { return false; } });
    if (!fr) return;
    const r = fr.getBoundingClientRect(), cs = getComputedStyle(fr);
    const x = r.left + fr.clientLeft + (parseFloat(cs.paddingLeft) || 0), y = r.top + fr.clientTop + (parseFloat(cs.paddingTop) || 0);
    frameOffset().then((o) => { try { ev.source.postMessage({ __wpOffsetRes: d.__wpOffsetReq, x: (o ? o.x : 0) + x, y: (o ? o.y : 0) + y, ok: !!o }, '*'); } catch {} });
  });
  function frameOffset() {
    if (window === window.top) return Promise.resolve({ x: 0, y: 0 });
    return new Promise((resolve) => {
      const id = Math.random().toString(36).slice(2);
      const done = (v) => { clearTimeout(t); removeEventListener('message', h); resolve(v); };
      const h = (ev) => { if (ev.source === window.parent && ev.data && ev.data.__wpOffsetRes === id) done(ev.data.ok ? { x: ev.data.x, y: ev.data.y } : null); };
      const t = setTimeout(() => done(null), 1200);
      addEventListener('message', h);
      try { window.parent.postMessage({ __wpOffsetReq: id }, '*'); } catch { done(null); }
    });
  }

  /** Numbered boxes over on-screen elements, for the AI's screenshot (number = digits after "_" in the id). */
  function drawMarks(ids) {
    document.getElementById('__webpilot_marks')?.remove();
    if (cur) cur.style.visibility = 'hidden';
    const layer = document.createElement('div');
    layer.id = '__webpilot_marks';
    Object.assign(layer.style, { position: 'fixed', inset: '0', zIndex: 2147483646, pointerEvents: 'none' });
    const colors = ['#e11d48', '#2563eb', '#16a34a', '#d97706', '#7c3aed', '#0891b2'];
    let n = 0;
    for (const id of ids) {
      const el = byWpId(id);
      if (!el || !inViewport(el)) continue;
      const r = el.getBoundingClientRect();
      if (r.width < 2 || r.height < 2) continue;
      const c = colors[n++ % colors.length];
      const box = document.createElement('div');
      Object.assign(box.style, { position: 'fixed', left: r.left + 'px', top: r.top + 'px', width: r.width + 'px', height: r.height + 'px', outline: `2px solid ${c}`, borderRadius: '3px' });
      const tag = document.createElement('div');
      tag.textContent = id.split('_').pop();
      Object.assign(tag.style, { position: 'absolute', left: '-2px', top: r.top > 14 ? '-15px' : '0', background: c, color: '#fff', font: 'bold 11px/13px monospace', padding: '0 3px', borderRadius: '3px' });
      box.appendChild(tag);
      layer.appendChild(box);
    }
    document.documentElement.appendChild(layer);
    return n;
  }

  /** Nearest scrollable ancestor of an element. */
  function scrollerOf(el) {
    for (let p = composedParent(el); p && p !== document.body && p !== document.documentElement; p = composedParent(p)) {
      const st = getComputedStyle(p);
      if (/(auto|scroll|overlay)/.test(st.overflowY) && p.scrollHeight > p.clientHeight + 20) return p;
    }
    return null;
  }
  /** When the window itself can't scroll (app-style layouts), the big inner panel that does. */
  function mainScroller() {
    const se = document.scrollingElement || document.documentElement;
    if (se.scrollHeight > innerHeight + 20 && getComputedStyle(document.body).overflowY !== 'hidden' && getComputedStyle(se).overflowY !== 'hidden') return null;
    let best = null, area = 0;
    for (const el of document.querySelectorAll('div, main, section, article, ul')) {
      if (el.scrollHeight <= el.clientHeight + 20) continue;
      const st = getComputedStyle(el);
      if (!/(auto|scroll|overlay)/.test(st.overflowY)) continue;
      const r = el.getBoundingClientRect();
      const a = Math.max(0, Math.min(r.right, innerWidth) - Math.max(r.left, 0)) * Math.max(0, Math.min(r.bottom, innerHeight) - Math.max(r.top, 0));
      if (a > area) { area = a; best = el; }
    }
    return area > innerWidth * innerHeight * 0.15 ? best : null;
  }

  async function execute(action, value, opts = {}) {
    // page-level actions (no target element)
    if (action.type === 'scroll') {
      const up = action.direction === 'up';
      const target = action.target ? byWpId(action.target) : null;
      const box = (target && scrollerOf(target)) || mainScroller();
      const dy = (up ? -1 : 1) * Math.round((box ? box.clientHeight : innerHeight) * 0.85);
      if (box) box.scrollBy({ top: dy, behavior: 'instant' }); else scrollBy({ top: dy, behavior: 'instant' });
      await sleep(350);
      return { detail: `scrolled ${up ? 'up' : 'down'}${box ? ' (inside the page scroll area)' : ''}` };
    }
    if (action.type === 'press' && !action.target) {
      await pressKey(null, action.key || 'Enter');
      return { detail: `pressed ${action.key || 'Enter'}` };
    }
    if (action.type === 'media' && !action.target) {
      const m = [...document.querySelectorAll('video, audio')].find((v) => isVisible(v)) || document.querySelector('video, audio');
      if (!m) throw new Error('There is no video or audio on this page.');
      action = { ...action, target: idOf(m) };
    }

    const el = byWpId(action.target);
    if (!el) throw new Error('That element is no longer on the page (the page may have changed).');
    if (el.disabled) throw new Error('That element is disabled.');
    const pre = el.getBoundingClientRect();
    if (pre.top < 0 || pre.bottom > innerHeight || pre.left < 0 || pre.right > innerWidth) {
      el.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' });
      await sleep(60);
    }

    const isRadio = el.type === 'radio' || isAriaRadio(el) || el.getAttribute('role') === 'radiogroup';
    const label = isRadio ? radioGroupLabel(radiosOf(el)) : ownLabel(el);
    let type = action.type;
    if (type === 'fill' && (el.tagName === 'SELECT' || isRadio)) type = 'select';
    if (type === 'select' && el.tagName !== 'SELECT' && !isRadio) type = 'fill';

    switch (type) {
      case 'fill': {
        if (isPaymentOrOtp(el)) throw new Error('WebPilot never fills CAPTCHAs, OTPs or card details — ask the user.');
        if (el.type === 'password' && !opts.allowPassword) throw new Error('Password fields can only be filled with a password generated by WebPilot.');
        if (!/^(INPUT|TEXTAREA)$/.test(el.tagName) && !el.isContentEditable) {
          // a wrapper (custom field / combobox box): type into the real field inside it, if there is one
          const inner = el.querySelector('input:not([type="hidden"]), textarea, [contenteditable="true"], [contenteditable=""]');
          if (inner) return execute({ ...action, target: idOf(inner) }, value, opts);
          throw new Error(`“${clean(label, 40)}” is not a text field — click it (or use choose for a dropdown) instead of typing.`);
        }
        if (el.readOnly) throw new Error(`“${clean(label, 40)}” is read-only — probably a date or option picker. Click it and pick the value instead.`);
        highlight(el, `Typing in “${clean(label, 40)}”`);
        await cursorToEl(el, `Typing in “${clean(label, 30)}”`);
        cursorClick();
        el.focus();
        if (el.type === 'date' || ['time', 'month', 'week', 'datetime-local', 'number', 'range'].includes(el.type)) {
          setNativeValue(el, el.type === 'date' ? toISODate(value) : String(value));
        } else {
          await typeProgressive(el, value);
        }
        cursorTag('');
        return { detail: `typed into “${clean(label, 40)}”` };
      }
      case 'select': {
        highlight(el, `Selecting in “${clean(label, 40)}”`);
        await cursorToEl(el, `Choosing “${clean(value, 30)}”`);
        cursorClick();
        if (el.tagName === 'SELECT') {
          const list = [...el.options].filter((o) => o.value !== '');
          const idx = bestOption(list.map((o) => ({ text: o.text, value: o.value })), value);
          if (idx < 0) throw new Error(`No option matching “${value}” in “${label}”. Options: ${list.slice(0, 12).map((o) => clean(o.text, 30)).join(', ')}`);
          setNativeValue(el, list[idx].value);
          return { detail: `chose “${clean(list[idx].text, 60)}”` };
        }
        const radios = radiosOf(el);
        const idx = bestOption(radios.map((r) => ({ text: radioOptionLabel(r), value: r.value || r.getAttribute('data-value') || '' })), value);
        if (idx < 0) throw new Error(`No option matching “${value}” in “${label}”. Options: ${radios.slice(0, 12).map(radioOptionLabel).join(', ')}`);
        const r = radios[idx];
        if (!radioChecked(r)) {
          const vis = isVisible(r) ? r : (r.labels && r.labels[0]) || r;
          realClick(vis);
          await sleep(80);
          if (!radioChecked(r) && !isAriaRadio(r)) { r.checked = true; r.dispatchEvent(new Event('input', { bubbles: true })); r.dispatchEvent(new Event('change', { bubbles: true })); }
        }
        return { detail: `chose “${radioOptionLabel(r)}”` };
      }
      case 'check':
      case 'uncheck': {
        const want = type === 'check';
        highlight(el, `${want ? 'Checking' : 'Unchecking'} “${clean(label, 40)}”`);
        await cursorToEl(el, want ? 'Check' : 'Uncheck');
        cursorClick();
        const role = el.getAttribute('role');
        if (role === 'checkbox' || role === 'switch') {
          if ((el.getAttribute('aria-checked') === 'true') !== want) realClick(el);
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
        await cursorToEl(el, `Click “${clean(label, 30)}”`);
        cursorClick();
        await sleep(60);
        realClick(el);
        return { detail: `clicked “${clean(label, 40)}”` };
      }
      case 'press': {
        const key = action.key || 'Enter';
        highlight(el, `Pressing ${key}`);
        await cursorToEl(el, `Press ${key}`);
        await pressKey(el, key);
        return { detail: `pressed ${key}` };
      }
      case 'media': {
        if (el.tagName !== 'VIDEO' && el.tagName !== 'AUDIO') throw new Error('That element is not a video or audio player.');
        highlight(el, action.op === 'pause' ? 'Pausing' : 'Playing');
        if (action.op === 'pause') { el.pause(); return { detail: 'paused' }; }
        try {
          await el.play();
        } catch {
          realClick(el);
          await sleep(500);
          if (el.paused) throw new Error('The browser blocked playback. Try clicking the play button instead.');
        }
        return { detail: 'playing' };
      }
      default:
        throw new Error('Unsupported action: ' + action.type);
    }
  }

  // used by the side panel to read every frame of the tab in one call
  window.__webpilot = { snapshot, frameOffset };

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    (async () => {
      try {
        if (msg.cmd === 'ping') return sendResponse({ ok: true });
        if (msg.cmd === 'snapshot') return sendResponse({ ok: true, data: await snapshot({ settle: msg.settle !== false }) });
        if (msg.cmd === 'frameOffset') return sendResponse({ ok: true, data: await frameOffset() });
        if (msg.cmd === 'stable') { await waitForStable({ max: msg.max || 2500 }); return sendResponse({ ok: true }); }
        if (msg.cmd === 'locate') return sendResponse({ ok: true, data: await locate(msg.target, msg.text) });
        if (msg.cmd === 'value') {
          const el = byWpId(msg.target);
          const v = !el ? null : /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) ? el.value
            : el.getAttribute('role') === 'radiogroup' || isAriaRadio(el) || el.type === 'radio' ? (radiosOf(el).filter(radioChecked).map(radioOptionLabel)[0] || '')
            : clean(el.innerText || el.textContent || el.getAttribute('aria-label') || '', 120);
          return sendResponse({ ok: true, data: v });
        }
        if (msg.cmd === 'options') return sendResponse({ ok: true, data: findOptions(msg.want || '', msg.near) });
        if (msg.cmd === 'marks') return sendResponse({ ok: true, data: drawMarks(msg.ids || []) });
        if (msg.cmd === 'unmarks') { document.getElementById('__webpilot_marks')?.remove(); if (cur) cur.style.visibility = ''; return sendResponse({ ok: true }); }
        if (msg.cmd === 'cursor') {
          if (msg.op === 'move') await cursorMove(msg.x, msg.y, msg.label, msg.from);
          else if (msg.op === 'click') cursorClick();
          else if (msg.op === 'tag') cursorTag(msg.label);
          else if (msg.op === 'hide') cursorHide();
          return sendResponse({ ok: true, data: curPos });
        }
        if (msg.cmd === 'href') {
          // absolute URL behind a link / button, used for downloads
          const el = byWpId(msg.target);
          const a = el && (el.closest('a[href]') || (el.querySelector && el.querySelector('a[href]')));
          return sendResponse({ ok: true, data: a ? a.href : (el && (el.getAttribute('data-href') || el.getAttribute('data-url'))) || '' });
        }
        if (msg.cmd === 'execute') return sendResponse({ ok: true, data: await execute(msg.action, msg.value, msg.opts) });
        sendResponse({ ok: false, error: 'Unknown command' });
      } catch (e) {
        sendResponse({ ok: false, error: e.message || String(e) });
      }
    })();
    return true; // async response
  });
})();
