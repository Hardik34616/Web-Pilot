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
| 2 | Open the demo form. Mode: **Review**. Run *"Fill my details, select CSE as my branch, accept the terms and prepare the form for submission"*. |
| 3 | Watch the live plan: fields highlight on the page as they're filled. WebPilot pauses before **Next →** and before accepting the terms. Approve both. |
| 4 | It moves through all 3 steps, maps "CSE" to *Computer Science and Engineering*, and **stops before Submit Registration**. |
| 5 | Switch to **Full Auto** and run *"Fill everything and submit the form"*. Routine steps run automatically, but the **Submit** click still asks for approval (red card). |
| 6 | Try **Step-by-step** to show per-action approval, then the **Workflows** tab (saved tasks + action history). |

---

## Autonomy modes

| Mode | Routine fills | Clicks / navigation / terms | Submit, pay, delete · 🔒 fields |
|---|---|---|---|
| ⚡ Full Auto | auto | auto | **asks** |
| 👀 Review | auto | **asks** | **asks** |
| 🪜 Step-by-step | **asks** | **asks** | **asks** |

Some actions are **always blocked**: filling passwords, OTPs, card numbers or ID numbers.

---

## Architecture

```
extension/
├── manifest.json          MV3: side panel, scripting, storage
├── background.js          opens the side panel on icon click
├── content/content.js     page snapshot + whitelisted action executor (fill/select/check/click)
└── sidepanel/
    ├── sidepanel.html/css UI: Agent · Profile · Workflows · Settings
    ├── sidepanel.js       agent loop: snapshot → plan → classify → approve → execute → re-plan
    ├── planner.js         LLM prompt + offline heuristic planner + plan validation
    ├── providers.js       Groq / OpenRouter / Gemini clients with retry + model fallback
    ├── safety.js          risk classification (routine / important / sensitive / blocked)
    ├── profile.js         profile fields, label→field matching, AI-import prompt & parser
    └── storage.js         chrome.storage.local wrapper
demo/index.html            3-step dummy registration site
```

**Agent loop:** for each page, the content script returns a compact list of interactive elements (labels, kinds, options, current values). The planner returns structured JSON actions. Each action is validated against the snapshot, classified by `safety.js` and either run or sent to the user for approval. After any click or navigation, the page is snapshotted again and re-planned, which is how multi-step forms work. If the page doesn't change, or an element disappears, WebPilot **stops safely and asks for help**.

**Privacy by design:**
- Profile values are stored only in `chrome.storage.local` and are **never sent to the LLM**. The AI sees field *names* only and returns `{"profileKey": "email"}` references. Values are filled in locally.
- The AI can't run JavaScript. It can only request `fill / select / check / uncheck / click / navigate` on element IDs that exist in the snapshot.

**Robustness details:** native value setters plus `input`/`change` events (works with React and Vue forms); fuzzy option matching (`CSE` → *Computer Science and Engineering*, `3` → *3rd Year*); date normalization (`14/08/2004` → `2004-08-14`); radio groups; custom-styled checkboxes; an on-page highlight overlay.

---

## Roadmap (beyond the MVP)
- React + Vite UI port; Node/Express backend proxy, so API keys aren't stored in the client
- Supabase sync for profiles and workflows across devices
- Cross-page workflows that open URLs, plus file upload (resume)
- Per-site permission rules and an exportable audit log
