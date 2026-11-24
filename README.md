# WebPilot AI 🚀

**An AI browser agent that doesn't just answer questions. It performs web tasks while you stay in control.**
Built for wHACKiest 2026 · Track 02: Beyond the Browser.

WebPilot is a Chrome (Manifest V3) side-panel extension. You type something like *"Fill my details, select CSE as my branch, accept the terms and prepare the form for submission"*. WebPilot reads the page, builds a plan you can see, fills the fields, picks dropdown and radio options, ticks checkboxes and moves through multi-step forms. It stops before anything irreversible.

---

## Quick start (2 minutes)

1. **Load the extension**
   - Open `chrome://extensions` and turn on **Developer mode** (top right).
   - Click **Load unpacked** and select the `extension/` folder.
   - Pin WebPilot AI and click its icon, or press **Alt+Shift+W**. The side panel opens.
2. **Fill your profile.** Go to the **Profile** tab and either type your details or use **✨ Import from ChatGPT / Gemini**.
3. **Open the demo form.** Serve the repo over HTTP:
   ```powershell
   python -m http.server 5500
   ```
   Then open http://localhost:5500/demo/
   (You can also open `demo/index.html` directly after turning on **Allow access to file URLs** in the extension's Details page.)
4. **Run a task.** In the **Agent** tab, pick a mode and click one of the suggestion chips.

### Optional: AI planner (free)
Without a key, WebPilot uses a built-in **offline matcher**. It reliably handles forms that map to profile fields and understands phrases like "select CSE as my branch", "accept the terms" and "submit".

For full natural-language understanding, add a free API key under **Settings**:

| Provider | Get a key | Default model |
|---|---|---|
| **Groq** (default, recommended) | https://console.groq.com/keys | `llama-3.3-70b-versatile` |
| OpenRouter (free models only) | https://openrouter.ai/keys | `meta-llama/llama-3.3-70b-instruct:free` |
| Google Gemini | https://aistudio.google.com/apikey | `gemini-3.8-flash` |

Choose the provider, paste the key, and click **Test connection**, then **Save**. The header dot turns green. If a model is overloaded, rate-limited or retired, WebPilot retries and then switches to another model from the same provider. If every model fails, it falls back to the offline matcher.

---

## Demo script (for judges)

| Step | What to show |
|---|---|
| 1 | Profile tab → **Copy prompt** → paste into ChatGPT → paste the reply back → **Preview import** → **Import selected**. |
| 2 | Open http://localhost:5500/demo/ in **Review** mode. Run *"Fill my details, select CSE as my branch, accept the terms and prepare the form for submission"*. It goes through all 3 steps, maps "CSE" to *Computer Science and Engineering*, and **stops before Submit Registration**. |
| 3 | Open http://localhost:5500/demo/signup.html in **Full Auto**. Run *"Create an account on this site using my details"*. It dismisses the cookie pop-up, fills the form, **generates a secure password** (shown to you with a Copy button), reads the site's error message, fixes it, submits, and **confirms "Account created!"** from the page. |
| 4 | Open a new tab and run *"Open YouTube and play the GTA 6 trailer"*. It navigates, searches, opens the video and checks that it's actually **playing** before it says it's done. |
| 5 | Run *"Fill everything and pay"* on any checkout page. The payment click always shows a red approval card, even in Full Auto. |
| 6 | Show the **Workflows** tab: saved tasks, action history and 🔑 saved passwords. |

---

## How the agent thinks

WebPilot runs a **goal-driven loop**, not a one-shot plan:

1. **Look:** snapshot the page: interactive elements (pop-ups first, then what's on screen), visible text, error messages, video play state.
2. **Think:** the LLM compares the page with the goal and returns the next 1–6 actions. Each step it sees the full history, e.g. `clicked "Search" → NO VISIBLE CHANGE` or `FAILED: no option matching…`.
3. **Act:** each action is safety-checked, approved if needed, then executed. After any click, Enter, navigation or back, it looks again.
4. **Verify:** it only finishes when the **current page proves the goal is done** (success message, video playing, results shown), with evidence.
5. **Recover:** failed actions are re-planned in a different way. If it repeats itself with no progress, or fails 3 times in a row, it **hands control to you** ("Your turn" card, where you can fix things on the page or type a hint) and then carries on.

Actions available to the AI: `fill`, `select`, `check`/`uncheck`, `click`, `press` (Enter/Escape/Tab…), `navigate`, `back`, `scroll`, `wait`, `media` (play/pause), `ask_user`. Links that open in a new tab are followed automatically.

---

## Autonomy modes

| Mode | Typing / scrolling | Clicks, navigation, terms, generated password | Submit / sign-up | Pay, buy, delete · 🔒 fields |
|---|---|---|---|---|
| ⚡ Full Auto | auto | auto | auto **if your goal asks for it**, otherwise asks | **always asks** |
| 👀 Review | auto | **asks** | **asks** | **always asks** |
| 🪜 Step-by-step | **asks** | **asks** | **asks** | **always asks** |

- **Never done by WebPilot:** typing OTPs/verification codes, card/CVV/bank/government ID numbers, or solving CAPTCHAs. It pauses and asks you to do these, then continues.
- **Passwords:** WebPilot only types passwords **it generated for a new account**. Each one is shown to you, with a Copy button and a copy in History. Logging in to existing accounts is left to you.

---

## Architecture

```
extension/
├── manifest.json          MV3: side panel, scripting, storage
├── background.js          opens the side panel on icon click
├── content/content.js     page snapshot (pop-ups, media, errors) + whitelisted action executor
└── sidepanel/
    ├── sidepanel.html/css UI: Agent · Profile · Workflows · Settings
    ├── sidepanel.js       agent loop: look → think → act → verify → recover
    ├── planner.js         agent prompt, plan validation, privacy masking, offline planner
    ├── providers.js       Groq / OpenRouter / Gemini clients with retry + model fallback
    ├── safety.js          risk classification (routine / important / sensitive / blocked)
    ├── profile.js         profile fields, label→field matching, AI-import prompt & parser
    └── storage.js         chrome.storage.local wrapper
demo/index.html            3-step dummy registration form
demo/signup.html           dummy sign-up page (with a cookie pop-up)
```

**Privacy by design:**
- Profile values are stored only in `chrome.storage.local` and are **never sent to the LLM**. The AI sees field *names* and returns `{"profileKey": "email"}` references, which are filled in locally. Once a value has been typed into a page, later snapshots mask it as `[your email]` before they're sent.
- The AI can't run JavaScript. It can only request whitelisted actions on elements that exist in the snapshot.

**Robustness details:** native value setters plus `input`/`change` events (works with React and Vue forms); fuzzy option matching (`CSE` → *Computer Science and Engineering*, `3` → *3rd Year*); date normalization (`14/08/2004` → `2004-08-14`); radio groups; custom-styled checkboxes; an on-page highlight overlay.

---

## Roadmap (beyond the MVP)
- React + Vite UI port; Node/Express backend proxy, so API keys aren't stored in the client
- Supabase sync for profiles and workflows across devices
- Cross-page workflows that open URLs, plus file upload (resume)
- Per-site permission rules and an exportable audit log
