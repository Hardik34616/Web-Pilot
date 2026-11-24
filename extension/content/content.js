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
  const SELECTOR = [
    'input', 'textarea', 'select', 'button', 'a[href]', 'summary', 'video', 'audio',
    '[role="button"]', '[role="link"]', '[role="checkbox"]', '[role="switch"]', '[role="tab"]',
    '[role="menuitem"]', '[role="option"]', '[role="combobox"]', '[role="searchbox"]', '[role="textbox"]',
    '[contenteditable="true"]',
  ].join(', ');
  const MAX_ELEMENTS = 260, MAX_LINKS = 140;

  const registry = new Map(); // id → element (also finds elements inside shadow DOM)
  function idOf(el) {
    if (!el.dataset.wpId) el.dataset.wpId = PREFIX + ++seq;
    registry.set(el.dataset.wpId, el);
    return el.dataset.wpId;
  }
  function byWpId(id) {
    const el = registry.get(id);
    if (el && el.isConnected) return el;
    return document.querySelector(`[data-wp-id="${CSS.escape(id || '')}"]`);
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
    let el = document.elementFromPoint(innerWidth / 2, innerHeight / 2);
    while (el && el !== document.body && el !== document.documentElement) {
      const s = getComputedStyle(el);
      if (s.position === 'fixed' && (parseInt(s.zIndex, 10) || 0) > 0) {
        const r = el.getBoundingClientRect();
        if (r.width * r.height > innerWidth * innerHeight * 0.15 && el.querySelector('button, a, [role="button"], input')) return el;
      }
      el = el.parentElement;
    }
    return null;
  }

  function describe(el, overlay) {
    const tag = el.tagName.toLowerCase();
    const type = (el.getAttribute('type') || '').toLowerCase();
    const role = el.getAttribute('role');
    let invalid = el.getAttribute('aria-invalid') === 'true';
    try { invalid = invalid || el.matches(':user-invalid'); } catch {}
    const base = {
      name: el.name || undefined,
      required: el.required || el.getAttribute('aria-required') === 'true' || undefined,
      invalid: invalid || undefined,
      popup: overlay && overlay.contains(el) ? true : undefined,
      offscreen: inViewport(el) ? undefined : true,
    };
    if (tag === 'video' || tag === 'audio') {
      return {
        id: idOf(el), kind: 'media', label: el.getAttribute('aria-label') || el.title || tag, ...base,
        playing: !el.paused && !el.ended && el.readyState > 2, paused: el.paused,
        time: Math.round(el.currentTime || 0), duration: Math.round(el.duration || 0) || undefined,
      };
    }
    if (type === 'checkbox' || role === 'checkbox' || role === 'switch') {
      const checked = type === 'checkbox' ? el.checked : el.getAttribute('aria-checked') === 'true';
      return { id: idOf(el), kind: 'checkbox', label: labelFor(el), checked, ...base };
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
      const label = labelFor(el);
      if (!label) return null;
      const href = el.href || el.getAttribute('href') || '';
      return { id: idOf(el), kind: 'link', label, href: clean(href, 120) || undefined, pdf: /\.pdf(\?|#|$)/i.test(href) || undefined, ...base };
    }
    if (tag === 'button' || tag === 'summary' || ['submit', 'button', 'reset', 'image'].includes(type) ||
        ['button', 'tab', 'menuitem', 'option'].includes(role) || (role === 'combobox' && tag !== 'input')) {
      const label = labelFor(el);
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
        autocomplete: el.getAttribute('autocomplete') || undefined, ...base,
        value: secret ? (el.value ? '••••' : '') : clean(el.value, 80), empty: !el.value,
      };
    }
    return null;
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

  function snapshot() {
    const overlay = overlayRoot();
    const editors = findEditors();
    const items = [];
    const seenGroups = new Set();
    for (const el of deepAll(SELECTOR)) {
      if (el.disabled) continue;
      if (el.closest('#__webpilot_overlay')) continue;
      if (editors.length && editors.some((ed) => ed.contains(el))) continue; // the editor is listed as one element
      const isMedia = el.tagName === 'VIDEO' || el.tagName === 'AUDIO';
      if (!isMedia && !isUsable(el)) continue;
      if (isMedia && !isVisible(el) && !(el.currentTime > 0)) continue;
      if (el.type === 'radio') {
        const key = (el.form ? 'f' : 'd') + ':' + el.name;
        if (!el.name || seenGroups.has(key)) continue;
        seenGroups.add(key);
        const radios = radiosOf(el);
        const checked = radios.find((r) => r.checked);
        items.push({
          id: idOf(radios[0]), kind: 'radio-group', label: radioGroupLabel(radios),
          popup: overlay && overlay.contains(el) ? true : undefined, offscreen: inViewport(el) ? undefined : true,
          options: radios.map(radioOptionLabel), value: checked ? radioOptionLabel(checked) : '', empty: !checked,
        });
        continue;
      }
      const d = describe(el, overlay);
      if (d) items.push(d);
      if (items.length > 1500) break;
    }
    // Priority: popup first, then what's on screen, then the rest of the page.
    for (const ed of editors) {
      const code = editorText(ed);
      items.unshift({ id: idOf(ed), kind: 'code-editor', label: `Code editor (${editorType(ed)})`, editorType: editorType(ed), value: code.slice(0, 6000), lines: code.split('\n').length });
    }
    const rank = (e) => (e.kind === 'code-editor' ? -1 : e.popup ? 0 : e.offscreen ? 2 : 1);
    const ordered = items.map((e, i) => [e, i]).sort((a, b) => rank(a[0]) - rank(b[0]) || a[1] - b[1]).map((x) => x[0]);
    const out = [];
    let links = 0;
    for (const e of ordered) {
      if (e.kind === 'link' && ++links > MAX_LINKS) continue;
      out.push(e);
      if (out.length >= MAX_ELEMENTS) break;
    }

    const headings = [...document.querySelectorAll('h1, h2, h3, legend')]
      .filter((h) => isVisible(h) && inViewport(h)).map((h) => textOf(h)).filter(Boolean).slice(0, 8);
    const errors = [...document.querySelectorAll('[role="alert"], [aria-live="assertive"], .error, .errors, .invalid-feedback, .field-error, [class*="error-message"], [class*="errorMessage"]')]
      .filter(isVisible).map((n) => textOf(n)).filter((t) => t && t.length < 200);
    const main = document.querySelector('main, [role="main"]') || document.body;
    return {
      url: location.href,
      title: document.title,
      isPdf: document.contentType === 'application/pdf',
      headings,
      popupText: overlay ? clean(overlay.innerText, 400) : '',
      errors: [...new Set(errors)].slice(0, 6),
      // coding pages need the whole problem statement
      text: clean(main ? main.innerText : '', editors.length ? 4000 : 1500),
      results: editors.length ? resultText(editors) : '',
      scroll: { atTop: scrollY < 50, atBottom: innerHeight + scrollY >= document.documentElement.scrollHeight - 50 },
      elements: out,
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
  function isPaymentOrOtp(el) {
    const ac = (el.getAttribute('autocomplete') || '').toLowerCase();
    return ac.startsWith('cc-') || ac === 'one-time-code' || /\b(otp|cvv|cvc|card number)\b/i.test(labelFor(el));
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

  async function execute(action, value, opts = {}) {
    // page-level actions (no target element)
    if (action.type === 'scroll') {
      const dy = (action.direction === 'up' ? -1 : 1) * Math.round(innerHeight * 0.85);
      scrollBy({ top: dy, behavior: 'instant' });
      await sleep(400);
      return { detail: `scrolled ${action.direction === 'up' ? 'up' : 'down'}` };
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
    el.scrollIntoView({ block: 'center', behavior: 'instant' });
    await sleep(60);

    const label = el.type === 'radio' ? radioGroupLabel(radiosOf(el)) : labelFor(el);
    let type = action.type;
    if (type === 'fill' && (el.tagName === 'SELECT' || el.type === 'radio')) type = 'select';
    if (type === 'select' && el.tagName !== 'SELECT' && el.type !== 'radio') type = 'fill';

    switch (type) {
      case 'fill': {
        if (isPaymentOrOtp(el)) throw new Error('WebPilot never fills OTPs or card details.');
        if (el.type === 'password' && !opts.allowPassword) throw new Error('Password fields can only be filled with a password generated by WebPilot.');
        highlight(el, `Typing in “${clean(label, 40)}”`);
        el.focus();
        if (el.isContentEditable && el.tagName !== 'INPUT' && el.tagName !== 'TEXTAREA') {
          document.execCommand('selectAll', false);
          document.execCommand('insertText', false, String(value));
        } else {
          const v = el.type === 'date' ? toISODate(value) : String(value);
          setNativeValue(el, v);
        }
        return { detail: `typed into “${clean(label, 40)}”` };
      }
      case 'select': {
        highlight(el, `Selecting in “${clean(label, 40)}”`);
        if (el.tagName === 'SELECT') {
          const list = [...el.options].filter((o) => o.value !== '');
          const idx = bestOption(list.map((o) => ({ text: o.text, value: o.value })), value);
          if (idx < 0) throw new Error(`No option matching “${value}” in “${label}”. Options: ${list.slice(0, 12).map((o) => clean(o.text, 30)).join(', ')}`);
          setNativeValue(el, list[idx].value);
          return { detail: `chose “${clean(list[idx].text, 60)}”` };
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
        await sleep(120);
        realClick(el);
        return { detail: `clicked “${clean(label, 40)}”` };
      }
      case 'press': {
        const key = action.key || 'Enter';
        highlight(el, `Pressing ${key}`);
        await sleep(60);
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

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    (async () => {
      try {
        if (msg.cmd === 'ping') return sendResponse({ ok: true });
        if (msg.cmd === 'snapshot') return sendResponse({ ok: true, data: snapshot() });
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
