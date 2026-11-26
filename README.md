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

**Tip: save keys for several providers.** If your main provider is rate-limited, WebPilot continues instantly with the next provider you have a key for (e.g. Groq → OpenRouter → Gemini).

---

## Demo script (for judges)

| Step | What to show |
|---|---|
| 1 | Profile tab → **Copy prompt** → paste into ChatGPT → paste the reply back → **Preview import** → **Import selected**. |
| 2 | Open http://localhost:5500/demo/ in **Review** mode. Run *"Fill my details, select CSE as my branch, accept the terms and prepare the form for submission"*. It goes through all 3 steps, maps "CSE" to *Computer Science and Engineering*, and **stops before Submit Registration**. |
| 3 | Open http://localhost:5500/demo/signup.html in **Full Auto**. Run *"Create an account on this site using my details"*. It dismisses the cookie pop-up, fills the form, **generates a secure password** (shown to you with a Copy button), reads the site's error message, fixes it, submits, and **confirms "Account created!"** from the page. |
| 4 | From a blank tab, run *"Download the CDS 1 2026 notification"* (demo: http://localhost:5500/demo/commission.html). WebPilot first writes a **plan** (go to the commission site → Examinations → Active Examinations → download the PDF → verify), then follows it and saves the PDF. With a real key, *"Download the NDA 1 2026 notification"* does the same on upsc.gov.in. |
| 4c | Open http://localhost:5500/demo/coding.html and run *"Solve this problem"*. WebPilot reads the statement and the starter code, writes a solution into the real Monaco editor, submits it, reads the judge's verdict, fixes the bug, and resubmits until it's **Accepted**. The same works on LeetCode-style sites. |
| 4b | Open a new tab and run *"Open YouTube and play the GTA 6 trailer"*. It navigates, searches, opens the video and checks that it's actually **playing** before it says it's done. |
| 5 | Run *"Fill everything and pay"* on any checkout page. The payment click always shows a red approval card, even in Full Auto. |
| 6 | Show the **Workflows** tab: saved tasks, action history and 🔑 saved passwords. |

---

## How the agent thinks

WebPilot runs a **goal-driven loop**, not a one-shot plan:

0. **Plan:** before acting, the AI interprets the command (exact exam/item names, years, "latest"), picks the right — preferably official — website, and writes a step list plus a "done when" condition. It's shown as a live checklist. If the right site isn't open, WebPilot goes there directly.
1. **Look:** snapshot the page: interactive elements (pop-ups first, then what's on screen), visible text, error messages, video play state.
2. **Think:** the LLM compares the page with the goal and returns the next 1–6 actions. Each step it sees the full history, e.g. `clicked "Search" → NO VISIBLE CHANGE` or `FAILED: no option matching…`.
3. **Act:** each action is safety-checked, approved if needed, then executed. After any click, Enter, navigation or back, it looks again.
4. **Verify:** it only finishes when the **current page proves the goal is done** (success message, video playing, results shown), with evidence.
5. **Verify automatically:** the plan includes machine-checkable "done" conditions (video playing, file downloaded, a success message shown, a URL), so WebPilot can confirm success itself without another AI call.
6. **Recover by itself:** WebPilot accepts the many ways weaker models phrase actions. Invalid actions are sent back to the model with the reason. If the AI still can't decide, or is unavailable, WebPilot uses **built-in moves**: close pop-ups, open the best-matching result (it understands acronyms and Roman numerals, e.g. GTA 6 = Grand Theft Auto VI, and prefers official results), play the video, download the matching PDF, use the site's search box, or search Google. It only asks you for things a human must do (OTP, CAPTCHA, logging in) or after many failed attempts.

Actions available to the AI: `fill`, `select`, `check`/`uncheck`, `click`, `press` (Enter/Escape/Tab…), `navigate`, `back`, `scroll`, `wait`, `media` (play/pause), `download` (saves a file via Chrome's downloads, waiting until it finishes), `set_code` (replaces the code in a Monaco / CodeMirror / Ace editor through the editor's own API), `ask_user`. Links that open in a new tab are followed automatically.

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
    ├── providers.js       Groq / OpenRouter / Gemini clients with retry + model and provider fallback
    ├── safety.js          risk classification (routine / important / sensitive / blocked)
    ├── profile.js         profile fields, label→field matching, AI-import prompt & parser
    └── storage.js         chrome.storage.local wrapper
demo/index.html            3-step dummy registration form
demo/signup.html           dummy sign-up page (with a cookie pop-up)
demo/commission.html       dummy exam-commission site with a downloadable notification PDF
demo/videos.html           dummy video site (search → results → autoplaying watch page)
demo/coding.html           dummy coding judge (real Monaco editor, runs JS test cases locally)
demo/mail.html             Gmail-style compose test page (recipient chips, contenteditable body, "Message sent" toast)
demo/rail.html             dummy train-booking site (login + CAPTCHA, autocomplete, date picker, custom dropdown, payment step)
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

**Speed:** step prompts are compact (around 1k tokens: on-screen elements first, duplicate links dropped), page settling polls every 100 ms, and a rate-limited model is put on cooldown and replaced instantly by the next one instead of waiting.

**Model quality:** tiny models (under about 20B parameters) are never used as automatic fallbacks, because they return invalid actions and get stuck. WebPilot briefly waits for a capable model or switches provider instead.

**Coding problems:** code editors aren't normal text boxes, so WebPilot writes code through the editor's own API, running in the page's JavaScript world. It finds the editor via `window.monaco`, Monaco's AMD loader, React's internal state (e.g. `@monaco-editor/react`), CodeMirror 5/6 or Ace. The AI gets the full problem statement, the current code (to keep the exact signature and language) and the judge's verdict. Submit/Run clicks on a coding page don't need approval. If a site locks its editor down completely, WebPilot asks you to click into the editor once and then continues.

## Seeing and acting like a person

- **Real clicks and keystrokes.** With *Real clicks & typing* on (Settings, on by default), WebPilot drives the page through Chrome's debugger. Websites receive genuine, trusted mouse and keyboard events, so it works on sites that ignore simulated input. Short values are typed key by key, which triggers autocomplete; existing text is selected and replaced first. While a task runs, Chrome shows a "WebPilot AI started debugging this browser" bar, which disappears when the task ends.
- **Vision.** With *Vision* on, every step sends the AI a screenshot with numbered boxes over each element. The number matches the element's id, so it sees the layout, popups and results the way you do. Screenshots go only to models that can read images (e.g. Llama 4 Scout on Groq, or Gemini); other models still get the text description.
- **Better element detection.** Fields get labels from the text next to them, even without a `<label>`. Clickable `div`s and `span`s are found by their pointer cursor (custom dropdowns, autocomplete suggestions, "Book Now" tiles). Anything hidden behind a popup is marked *covered*, so the AI closes the popup first instead of clicking blindly.
- **Logins.** WebPilot types the username, then asks you to enter the password and CAPTCHA. It never types real passwords or solves CAPTCHAs, and CAPTCHA text is scrubbed from everything sent to the AI. Then it carries on. Payments always stop for your approval.

Demo: open http://localhost:5500/demo/rail.html and run *"Log in as asha_rao, search trains from New Delhi to Mumbai in AC 3 Tier and go till the last step"*. You'll be asked once (password + CAPTCHA, which is `K7Q2X` in the demo). WebPilot then picks stations from the autocomplete, uses the date picker and the class dropdown, searches, books, fills the passenger details and stops at **Proceed to Pay**.

**Autocomplete pickers and pop-ups.** Station, city and airport fields (and custom dropdowns) use one `choose` action. WebPilot types the value with real keys, waits for the suggestion list, clicks the best match and checks the field. It never scrolls the page while doing this, because lists like IRCTC's close on scroll. Pop-ups that aren't part of your task (advisories, promos, app-download and notification prompts, cookie banners) are closed automatically, without an AI call, including ones whose only close button is an icon. With a screenshot, providers that have image-capable models are tried first, and each step shows 👁 when the AI actually saw the screen.

### Free models that can see the screen
WebPilot reads each provider's catalogue to see which models really accept images, and sends screenshots only to those. It never uses tiny models. As of November 2026:

| Provider (free) | Image-capable models WebPilot uses | Key |
|---|---|---|
| **OpenRouter** | `google/gemma-4-31b-it:free`, `nvidia/nemotron-3.5-super-vl:free`, `google/gemma-4-26b-a4b-it:free` | https://openrouter.ai/keys |
| **Google Gemini** | Gemini Flash models | https://aistudio.google.com/apikey |
| Groq | Llama 4 Scout / Maverick *when Groq offers them* | https://console.groq.com/keys |

**Test connection** in Settings tells you whether the selected provider can see screenshots. If none of your keys can, WebPilot warns you when a task starts. For the best results, add a free OpenRouter key alongside Groq: Groq handles fast text steps, and OpenRouter's Gemma 4 sees the screen.

### Tested on the real IRCTC site
Using WebPilot's own content script and real input on irctc.co.in (without logging in):
- The "Welcome / select your preferred language" pop-up is closed by choosing **English**. IRCTC's buttons carry broken `aria-label`s, so WebPilot falls back to the visible text.
- **From "New Delhi"** → `NEW DELHI - NDLS (NEW DELHI)` and **To "Mumbai Central"** → `MUMBAI CENTRAL - MMCT (MUMBAI)`, picked from IRCTC's live suggestion list without scrolling it shut.
- The **date** is typed (`15/12/2026`), and IRCTC's calendar jumps to that month.
- **Class "AC 3 Tier (3A)"** and **Quota "TATKAL"** are picked from IRCTC's PrimeNG dropdowns. The dropdowns are named from their wrappers ("Journey Class", "Journey quota"), the list is scrolled to reach options further down, and "3A" can never be mistaken for "2A".
- MakeMyTrip's login pop-up (icon-only ×) is found and closed.
- **Search Trains** returns IRCTC's real results ("13 Results for NEW DELHI → MUMBAI CENTRAL | Tue, 15 Dec 2026"). Repeated buttons get their card's name, e.g. "Book Now · GOLDEN TEMPLE M (12904)" and "AC 3 Tier (3A) Refresh · GOLDEN TEMPLE M (12904)", so the AI can tell trains and classes apart.
- Picking the class tile and a date cell ("Tue, 15 Dec WL31"), then **Book Now**, works. IRCTC's own "booking from NZM to BDTS — continue?" question is left to the AI (question pop-ups are never auto-closed), and **Yes** leads to IRCTC's login pop-up, where WebPilot asks you for the password and CAPTCHA.


## Watching the agent work

- **WebPilot cursor.** While a task runs, a small cursor appears on the page and glides to the exact point of every action *before* it happens. On the real-input path the side panel moves the cursor to the coordinates the trusted click is about to use; on the in-page path it moves to the element's centre, where the in-page click is dispatched. Clicks show a subtle pulse, and a small tag says what's happening ("Click “Send”", "Typing in “Subject”"). The cursor is purely visual (it ignores the mouse) and fades out when the task ends.
- **Visible typing.** Short values are typed key by key and long text streams in as small chunks of genuine input events, so you watch the text appear in the field.
- **Activity indicator.** Under the header, a dot plus a short status ("Reading page", "Planning task", "Analyzing page", "Clicking “Compose”", "Typing in “Message Body”", "Waiting for page", "Action requires approval", "Task completed") shows what the agent is doing right now.

## Email (Gmail)

Ask, for example, *"Send an email to prof@college.edu with the subject Extension request saying …"*. WebPilot clicks **Compose**, types the address into **To recipients**, fills **Subject** and **Message Body**, and clicks **Send** only when your task says to send. It reports success only after Gmail shows **"Message sent"**. Toasts like that are read as page notifications. Ask for a *draft* and it stops before Send.

**Regression fixed (Nov 2026):** Gmail's "To" box is an autocomplete (`role="combobox"`). An earlier change automatically turned typing into such fields into *choose* (type, then click a suggestion), and there is no suggestion for a new address, so the recipient was never entered. Free-text autocomplete fields (email recipients, CC/BCC, search boxes, subjects) are typed again, while station and city pickers still use *choose*. If *choose* finds no suggestion in a free-text field, it keeps the typed text (and presses Tab to turn an address into a recipient chip). Pop-ups that contain a form, like Gmail's compose window, are never auto-closed.

`demo/mail.html` mirrors the structure of Gmail's compose UI for repeatable testing without an account.

## Appearance

Settings → **Theme**: **System** (follows the OS), **Light** or **Dark**. Both themes come from the same design tokens in `sidepanel.css`. The choice is saved, and `theme-init.js` applies it before the first paint, so the panel never flashes the wrong theme.
