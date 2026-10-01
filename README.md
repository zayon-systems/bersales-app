# Bersales — v1 build

Standalone PWA (HTML/CSS/JS, no build step) — same pattern as PER: deploy to GitHub Pages, wrap into an Android APK with Median.co.

**Renamed from Civora to Bersales (2026-10-01).** This is a product name, not a company name — Zayon Systems is still the company this ships under. The rename touched the app's display name, icons, color palette (now matched to the Bersales logo), and the internal storage keys/IndexedDB name (`bersales_salt`, `bersales_db`, etc., previously `civora_*`). If you loaded the old Civora build on a test phone, this version won't see that old data — it's a fresh vault under new keys.

## What's in this build

This now covers Phase 1 + 2 + 3 + most of what would've been later phases, pulled forward because the app's scope grew over the course of building it — see "A note on scope" below.

**Vault**
- PIN/password lock, with all data encrypted at rest (AES-GCM, key derived from your PIN via PBKDF2 — see `js/crypto.js`)
- Document vault: add, view, edit, delete, categorize — 36 document types across government IDs, firearms licensing (LTOPF, firearm registration/COR, PTCFOR), business registration (DTI, BIR 2303), employment/school/membership/HOA/residence IDs, a free-text "Other ID (Custom)" type for anything not in the list, medical records, insurance, warranties, and receipts — see `js/templates.js`
- Each document can hold more than one scanned page (front/back of an ID, a multi-page certificate) — each page is an individual flat scan, never merged into a PDF; add/remove pages from the document form
- Camera capture **or** import an existing photo from the gallery — both feed the same crop/enhance pipeline
- Corner auto-detection: an edge-contrast heuristic guesses the document's 4 corners automatically, still shown as draggable handles for manual correction — see the design note at the top of `js/scanner.js` for why this isn't full OpenCV-style detection (deliberate — an 8MB+ WASM dependency is a bad trade for an offline-first, small-footprint app)
- One-tap auto-enhance (gray-world white balance + contrast stretch + shadow lift) — on by default, togglable per scan
- OCR field extraction (Tesseract.js, runs in-browser) with manual entry always available as a fallback — see `js/ocr.js`
- Expiry tracking, per-document status (no aggregate "health score" — cut deliberately, see the spec), and a unified "next 30 days / needs attention" Home view across every time-bound thing in the app — see `js/reminders.js`

**Money**
- Debt tracker (`js/debts.js`): money you owe / money owed to you, a manual payment log, settled flag — a recording tool, not a bank connection
- Bills tracker (`js/bills.js`): due date, category (including Subscriptions), recurring flag, paid-this-cycle toggle. Shows two summary tiles: **Total Unpaid** (sum of everything with `paid: false`) and **Monthly Recurring (est.)** — a budgeting estimate that normalizes weekly/monthly/yearly bills onto a common monthly figure (weekly × 52/12, not a naive ×4, since months aren't 4 weeks) and deliberately ignores whether this cycle's instance happens to be paid yet
- Credit Cards (`js/creditcards.js`), as a tab under Bills: statement cutoff day and payment due day, each a day-of-month that auto-rolls to next month on its own with no manual re-entry — the one case in this app where recurring reminders actually regenerate themselves (see the note in `js/bills.js` on why that doesn't generalize to bills yet). You track `amountDue` manually (like Debts' outstanding balance), and the tab shows a **Total Due** tile summing it across all cards
- Home screen shows a **Total You Owe Right Now** tile: unpaid bills + money you owe (unsettled) + credit card amounts due, added together. Deliberately excludes "money owed to you" — mixing a liability total with money coming back to you would make the headline number misleading

**More (personal organizer)**
- Health Reminders (`js/health.js`): medical/dental/vaccination/medication-refill due dates, recurring interval, done-this-cycle toggle — same shape as Bills, same known limitation (you update the next due date yourself after marking one done)
- To-Dos (`js/todos.js`): task title, optional due date, notes, a done flag independent of its checklist, and a per-task checklist of steps (add/check/remove) — checklist editing unlocks after the to-do's first save, same pattern as the debt payment log. The list header shows a quick "X of Y done" count

**Everywhere**
- System / Light / Dark theme setting (Settings → Appearance), defaulting to System. The light palette is **not** the dark palette inverted — the brand red and the status colors were re-picked and contrast-checked against WCAG AA specifically for light backgrounds (see the comment above `:root[data-theme="light"]` in `css/styles.css`); the same red that works as white-on-red button fill fails as plain text on a light background, so there's a separate `--accent-text` variable for that case. Applied via a tiny inline script in `<head>` before the stylesheet paints, so there's no flash-of-wrong-theme on launch. The preference itself lives in plain `localStorage` (not the encrypted vault) since it's a UI setting, not personal data, and needs to be readable before unlock.
- Encrypted backup export (Settings → Export) — downloads a JSON file containing your encrypted records + salt/verifier, so you have a way to not lose everything if the device is lost, without any cloud involvement
- Everything runs on-device. No server, no analytics, no network calls except the one-time Tesseract.js engine download on first OCR use (see the caveat comment in `js/ocr.js`)

## Bugs found and fixed while building the totals feature

Writing the new summary tiles meant writing tests with precise numeric expectations, which surfaced two pre-existing bugs (present since the original build, not introduced by the totals work itself):

- **`js/bills.js` — `addBill()`:** the `paid` field was hardcoded to `false` in the record literal, ignoring the `paid` argument entirely. Creating a new bill with "Paid" already checked silently saved it as unpaid. Fixed: `paid: !!bill.paid`.
- **`js/debts.js` — `addDebt()`:** same pattern — `settled` was hardcoded to `false`. Logging a historical, already-settled debt (e.g. an old paid-off loan, entered for record-keeping) silently saved it as still active. Fixed: `settled: !!debt.settled`.

Both only affected the *create* path — editing an existing bill/debt's paid/settled flag via the toggle always worked correctly, which is likely why these went unnoticed until the totals math made the discrepancy visible as a wrong number instead of a subtly wrong checkbox state.

## A note on scope

The original spec was "a document vault with debts and bills." Over the course of this build it grew — credit card cutoffs, health check-up reminders, a to-do list — into something closer to a general personal organizer. Each addition reused the app's existing patterns (encrypted-at-rest records, a due-date/recurring/status shape, the same Home aggregation), so the architecture held up without a rework. Worth knowing if you're thinking about the 12-month target and how "document vault" as a one-line pitch compares to what's actually in the app now.

## Not yet built

- Family profiles, emergency info, dedicated vehicle/property record UI (the data model already supports vehicle/property as document categories, but there's no dedicated UI for them beyond the generic vault)
- Backup **import** (export works; re-importing a backup file into a fresh install is not wired up yet — `DB.putRaw` + `Crypto`'s salt/verifier restore are the pieces you'd need, straightforward to add)
- The in-app "this file will no longer be protected once shared" notice at share time — no OS-share-sheet integration exists yet since there's no sharing feature built at all yet
- Recurring bills (the generic kind — utilities, rent, etc.) still don't auto-regenerate next cycle's due date; only Credit Cards and Health Reminders' day-of-month math does this automatically where it applies

## Local testing

No build tools needed. From this folder:

```
python3 -m http.server 8080
```

Then open `http://localhost:8080` in a **mobile-width browser window** (or your phone on the same network, `http://<your-computer-ip>:8080`) — camera access needs a real camera, so desktop testing without a webcam will only get you through the "skip photo" or "import from gallery" paths.

**Note:** camera access (`getUserMedia`) requires either `localhost` or HTTPS. It will not work over plain `http://<ip>` from another device — for on-device testing before you deploy, use GitHub Pages (HTTPS by default) or a tool like `ngrok`.

## Deploying (same as PER)

1. Push this folder to a GitHub repo, enable GitHub Pages on it.
2. Confirm it loads and the camera/scan flow works in mobile Chrome first — easier to debug there than inside a wrapped app.
3. Wrap the GitHub Pages URL with Median.co into an Android APK, same project pattern as PER.
4. **Enable camera permission** in Median's app capabilities — same category of step as enabling GPS was for PER.

## Lessons carried over from PER (read before you debug the same things twice)

- **Stale version / caching:** PER got stuck serving its very first cached version because the service worker used a static cache name with cache-first for everything. This build's `service-worker.js` already fixes that — HTML is network-first, and the cache name is versioned (`CACHE_VERSION` at the top of the file). **Bump `CACHE_VERSION` every time you push an update**, or you'll hit the exact same stuck-on-old-version bug again. (Currently `v1.5.0`.)
- **Test on-device, not just desktop:** PER's GPS lock, save-to-phone, and share-sheet issues only showed up in the wrapped Median app, not in a desktop browser. The crop/drag interaction here (dragging the 4 scan corners) uses pointer events, which behave differently across mobile WebViews — test the actual drag gesture on your Samsung A54/A56 before assuming it works.
- **`window.prompt()` / `confirm()` / file downloads:** Settings → Change PIN uses `prompt()`, and Export uses a generated `<a download>` link. Both are standard web APIs, but Median's WebView needs JS dialogs and downloads enabled — given PER's history of "Save-to-phone silently failed," test these two specifically before relying on them.

## Security notes for your own review

- PBKDF2 iterations are set high (250,000) since this only runs once per unlock, on-device — no server cost to worry about.
- The PIN itself is never stored, only a random salt and a "verifier" ciphertext (both non-secret) in `localStorage`. Forgetting the PIN means the data is unrecoverable by design — there's no backdoor, which is the point, but make sure that trade-off is communicated clearly to users (the PIN setup screen already says this).
- Document images are stored in their own encrypted IndexedDB store, separate from document metadata, keyed by document id (`js/db.js`) — list/Home rendering never decrypts image bytes just to show a title and a status pill, and a document can hold multiple pages without bloating the metadata record.
- Credit card records never ask for a full card number, only the last 4 digits — there's no reason a full PAN needs to exist anywhere in this app, encrypted or not.
- IndexedDB stores: `documents`, `images`, `debts`, `bills`, `creditCards`, `healthReminders`, `todos` (`DB_VERSION` 4) — every store is covered automatically by Settings → Change PIN's re-encryption pass and by the encrypted export, since both iterate `DB.STORES` rather than naming stores individually. Adding a new tracker later just means adding its name to that array.
