// Real input: genuine (trusted) mouse clicks and keystrokes through the Chrome DevTools Protocol.
// Websites receive exactly the events a person would produce — unlike JavaScript-dispatched events,
// which many sites ignore. While attached, Chrome shows a "started debugging this browser" bar.

const attached = new Set();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const cmd = (tabId, method, params = {}) => chrome.debugger.sendCommand({ tabId }, method, params);

chrome.debugger?.onDetach.addListener((src) => attached.delete(src.tabId));

/** Attach to a tab (idempotent). Returns true when real input is available. */
export async function attach(tabId) {
  if (!chrome.debugger) return false;
  if (attached.has(tabId)) return true;
  try {
    await chrome.debugger.attach({ tabId }, '1.3');
  } catch (e) {
    if (!/already attached/i.test(e.message || '')) throw e;
  }
  attached.add(tabId);
  // Make the page behave as if it has focus even while the side panel is focused
  // (editors and inputs ignore typing in unfocused pages).
  await cmd(tabId, 'Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => {});
  return true;
}

export async function detachAll() {
  for (const tabId of [...attached]) {
    try { await chrome.debugger.detach({ tabId }); } catch { /* tab may be gone */ }
  }
  attached.clear();
}

export const isAttached = (tabId) => attached.has(tabId);

/** A real left click at viewport coordinates (CSS pixels). */
export async function click(tabId, x, y, clickCount = 1) {
  await cmd(tabId, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
  await sleep(30);
  await cmd(tabId, 'Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount });
  await sleep(40);
  await cmd(tabId, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount });
}

export async function hover(tabId, x, y) {
  await cmd(tabId, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
}

export async function wheel(tabId, x, y, deltaY) {
  await cmd(tabId, 'Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX: 0, deltaY });
}

const KEYS = {
  Enter: { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' },
  Tab: { key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 },
  Escape: { key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 },
  Backspace: { key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 },
  Delete: { key: 'Delete', code: 'Delete', windowsVirtualKeyCode: 46 },
  ArrowDown: { key: 'ArrowDown', code: 'ArrowDown', windowsVirtualKeyCode: 40 },
  ArrowUp: { key: 'ArrowUp', code: 'ArrowUp', windowsVirtualKeyCode: 38 },
  ArrowLeft: { key: 'ArrowLeft', code: 'ArrowLeft', windowsVirtualKeyCode: 37 },
  ArrowRight: { key: 'ArrowRight', code: 'ArrowRight', windowsVirtualKeyCode: 39 },
  Home: { key: 'Home', code: 'Home', windowsVirtualKeyCode: 36 },
  End: { key: 'End', code: 'End', windowsVirtualKeyCode: 35 },
  PageDown: { key: 'PageDown', code: 'PageDown', windowsVirtualKeyCode: 34 },
  PageUp: { key: 'PageUp', code: 'PageUp', windowsVirtualKeyCode: 33 },
  ' ': { key: ' ', code: 'Space', windowsVirtualKeyCode: 32, text: ' ' },
};

/** Press a key (e.g. "Enter", "Tab", "ArrowDown", "a"). modifiers: 1 Alt, 2 Ctrl, 4 Meta, 8 Shift. */
export async function press(tabId, key, modifiers = 0, commands) {
  const k = KEYS[key] || {
    key,
    code: /^[a-z]$/i.test(key) ? 'Key' + key.toUpperCase() : /^\d$/.test(key) ? 'Digit' + key : key,
    windowsVirtualKeyCode: key.length === 1 ? key.toUpperCase().charCodeAt(0) : 0,
    text: key.length === 1 && !modifiers ? key : undefined,
  };
  const down = { type: k.text && !modifiers ? 'keyDown' : 'rawKeyDown', modifiers, key: k.key, code: k.code, windowsVirtualKeyCode: k.windowsVirtualKeyCode, nativeVirtualKeyCode: k.windowsVirtualKeyCode };
  if (k.text && !modifiers) { down.text = k.text; down.unmodifiedText = k.text; }
  if (commands) down.commands = commands;
  await cmd(tabId, 'Input.dispatchKeyEvent', down);
  await cmd(tabId, 'Input.dispatchKeyEvent', { type: 'keyUp', modifiers, key: k.key, code: k.code, windowsVirtualKeyCode: k.windowsVirtualKeyCode, nativeVirtualKeyCode: k.windowsVirtualKeyCode });
}

const isMac = () => /Mac/i.test(navigator.userAgentData?.platform || navigator.platform || '');

/** Ctrl/Cmd+A with the editor's selectAll command, so existing text gets replaced. */
export async function selectAll(tabId) {
  await press(tabId, 'a', isMac() ? 4 : 2, ['selectAll']);
}

/**
 * Type text. Short values are typed key by key (triggers autocomplete / per-key handlers like a person);
 * long values are inserted in one go.
 */
export async function typeText(tabId, text, { slow = true } = {}) {
  const s = String(text);
  if (!slow || s.length > 60) {
    // Long text (messages, descriptions): genuine insertText in small chunks, so it visibly streams in
    // like fast typing instead of appearing all at once. Capped at ~60 chunks to stay quick.
    const size = Math.max(4, Math.ceil(s.length / 60));
    for (let i = 0; i < s.length; i += size) {
      await cmd(tabId, 'Input.insertText', { text: s.slice(i, i + size) });
      await sleep(12);
    }
    return;
  }
  for (const ch of s) {
    if (ch === '\n') { await press(tabId, 'Enter'); continue; }
    await cmd(tabId, 'Input.dispatchKeyEvent', { type: 'keyDown', key: ch, text: ch, unmodifiedText: ch });
    await cmd(tabId, 'Input.dispatchKeyEvent', { type: 'keyUp', key: ch });
    await sleep(18);
  }
}
