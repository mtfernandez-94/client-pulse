# Client Pulse — Context Summary for Claude Code

**Purpose:** Paste this into a new Claude Code session to restore full context. Last updated: March 2025.

---

## 1. Project Overview

**Client Pulse** is a local web dashboard for managing online calisthenics coaching clients. It replaces Google Sheets, which broke when clients paused, couldn't clear renewal flags, and had no visual timeline.

- **Stack:** Vanilla HTML/JS, Tailwind CDN, no build system, no framework
- **Run:** `python3 -m http.server 8080` → open http://localhost:8080
- **Data:** localStorage (primary), `clients_seed.json` (fallback)

---

## 2. Technical Summary of Works Completed

### Sprints 1–4 (Foundation)
- **Sprint 1:** CLAUDE.md, `.claude/settings.json` permissions, git init
- **Sprint 2:** Schema-driven dashboard table, health/status badges, renewal + review flags, sorting, filtering
- **Sprint 3:** Extracted date logic into `dateEngine.js`; `termToDays`/`bonusToDays` from schema.json
- **Sprint 4:** Add-client modal (single step), inline health dropdown, click name → edit modal, localStorage persistence

### Sprint 5 (Pause System)
- Pause button in edit modal footer (grey, next to Save Changes)
- Pause form: 3 modes — (1) Duration from today, (2) Duration from date, (3) From–To (date range)
- Preview shows exact weeks + days before confirming
- Reason optional; `pause_history` records `{ paused_date, resumed_date, weeks, reason, health_before_pause }`
- Resume: restores `health` from `pause_history.health_before_pause`; no separate health flow

### Sprint 5 (Hooks)
- `.cursor/hooks.json`: `afterFileEdit` → formats `clients_seed.json`; `sessionStart` → renewal summary
- Hooks: `format-clients.js`, `session-start.js`

### Sprint 6 (Review & Renewal)
- **Reviews:** In edit modal, list of calculated reviews; "Mark complete" → sets `reviews.review_N.completed = true`, `completed_date`
- **Renewals:** Click Renew Contact cell (when pending) → modal with outcome (renewed/churned/paused), notes, new program_start if renewed

### Sprint 7 (Gantt)
- Table/Gantt toggle; custom CSS timeline (no library)
- Bars colour-coded by health; today line; amber = renew contact, blue dots = reviews; click bar → edit modal

### Sprint 8 (Archive/Reactivate)
- Archive: `status → archived`; Reactivate: new `program_start` (+ optional term) → `status active`, `health Onboarding`, `renewal pending`

### Backlog (Done)
- Sort by all columns; payment sorts by currency then amount; Period column sorts by payment type
- Processor column added to schema `table_columns`

### UI Redesign (Attempted, Not Visible)
- Tailwind classes updated in `index.html`, `app.js`, `addClient.js` for minimalist Apple/Squarespace aesthetic
- **Problem:** Changes did not produce visible differences in the app — see Section 5 for troubleshooting

---

## 3. Next Steps (Prioritised)

### 1. Refining Features

**a) Complete reviews like renewals**
- Renewals: click cell → modal → choose outcome → save. Reviews: currently "Mark complete" in edit modal only.
- **Goal:** Make overdue/upcoming reviews clickable in the table (like Renew Contact), open a dedicated "Complete review" modal with optional notes, mirroring the renewal flow.

**b) Export to CSV**
- Add "Export to CSV" button (e.g. in header or controls bar).
- Export visible/filtered clients with all table columns + key fields. Use `schema.json` `table_columns` to drive column order.

### 2. UI Changes Troubleshooting (See Section 5)

### 3. Deploy Live (Near Zero Cost)
- Options: GitHub Pages, Netlify, Vercel (static hosting, free tier)
- **Caveat:** App uses localStorage — data is per-browser, not shared. For multi-device, would need backend/DB later.

---

## 4. Current Architecture & Where to Find Things

### File Map

| File | Purpose | Claude Should |
|------|---------|---------------|
| **CLAUDE.md** | Project context, rules, key files | Read first; contains schema-first, status/health rules |
| **schema.json** | Single source of truth for data structure | Edit here to add columns, enums, fields; UI adapts |
| **planning_context.md** | Business rules, decisions, backlog | Reference for "why" and future features |
| **curriculum.md** | Sprint-by-sprint teaching plan | Reference for teaching style and sprint order |
| **index.html** | App shell, header, controls, table/gantt containers, modal div | Add new UI containers or scripts here |
| **app.js** | Main app: render, filter, sort, edit modal, pause, renewal, archive, gantt | Core logic; add features here |
| **addClient.js** | Add-client modal, validation, submit | Add-client flow only |
| **dateEngine.js** | Pure date calculations | Read for date logic; don't hardcode term/bonus days |
| **clients_seed.json** | Seed data (40 clients) | Fallback; app loads from localStorage first |
| **.cursor/hooks.json** | Hook config | Defines when hooks run |
| **.cursor/hooks/*.js** | Hook scripts | Run on file edit / session start |

### Data Flow

```
schema.json ──► tableColumns, termToDays, bonusToDays
                    │
clients_seed.json ──┼──► localStorage (clientPulse_clients) ◄── allClients[]
                    │
                    ▼
              dateEngine.js (endOfCommitment, renewContact, calculateReviews, nextReview)
                    │
                    ▼
              app.js: getVisible(), render(), renderCell(), modals
```

### Key Patterns

1. **Schema-first:** Add `table_columns` entry → column appears. Add enum option → dropdown updates.
2. **Status:** `active` | `paused` | `archived` — only changed via Pause/Resume, Archive/Reactivate.
3. **Health:** Auto "🆕 Onboarding" on add; editable inline; on resume, restored from `pause_history.health_before_pause`.
4. **Calculated fields:** `calc.end_of_commitment`, `calc.renew_contact`, `calc.next_review` — dispatched in `getCalc()` in app.js, call dateEngine with `termToDays`, `bonusToDays`.
5. **Modals:** All use `#add-client-modal`; `modal.innerHTML = ...` replaces content. `closeModal()` clears and hides.

### Global State (app.js)

```js
allClients, tableColumns, termToDays, bonusToDays, schemaCache
filterStatus, filterHealth, filterTerm, sortCol, sortDir, viewMode
```

### Functions to Reuse

- `getPath(obj, path)` — dot-notation lookup
- `parseDate(str)`, `addDays`, `daysDiff`, `fmt` — in dateEngine.js (global)
- `todayISO()` — in app.js
- `saveClients()` — writes to localStorage
- `openEditModal(idx)`, `closeModal()` — edit modal
- `render()`, `renderStats()` — refresh UI

### Cell Types (schema.json `cell_type`)

- `name` — clickable, opens edit
- `health_badge` — inline dropdown
- `status_badge` — read-only badge
- `text`, `date` — display
- `payment` — custom payment cell
- `calc_date` — from getCalc
- `renewal_flag` — clickable when pending, opens renewal modal
- `review_flag` — display only (no click yet — see Next Steps)

---

## 5. UI Changes Troubleshooting — Why Styles Didn't Apply

### What Was Changed

Tailwind classes were updated across `index.html`, `app.js`, and `addClient.js` for a minimalist Apple/Squarespace look:

- **Modals:** `bg-black/30 backdrop-blur-sm`, `shadow-2xl`, `ring-1 ring-stone-200/50`, `rounded-2xl`
- **Inputs:** `border-stone-200`, `focus:ring-stone-900/10`, `text-[13px]`, `py-2.5`
- **Labels:** `text-[12px] font-medium text-stone-500`
- **Badges:** `ring-1 ring-*-200/60`, smaller `text-[11px]`
- **Header/controls:** `backdrop-blur-xl`, `border-stone-200/60`, `bg-stone-50`

### Likely Cause: Tailwind CDN + Dynamic HTML

**index.html** uses:

```html
<script src="https://cdn.tailwindcss.com"></script>
```

The default Tailwind CDN (v3) uses **JIT** and scans for class names at **build/load time**. Classes that exist only in **JavaScript strings** (e.g. `modal.innerHTML = \`...\`` in app.js) are **not in the initial HTML**. The CDN may:

1. **Not see them** — scan runs before modals are opened
2. **Not include them** — pre-built CDN bundle may omit less common utilities (`backdrop-blur-sm`, `ring-stone-200/50`, etc.)

### How to Fix

**Option A: Safelist in Tailwind config**

In `index.html`, extend the Tailwind config to force inclusion of dynamic classes:

```html
<script>
  tailwind.config = {
    content: ['./**/*.{html,js}'],
    safelist: [
      'backdrop-blur-sm', 'backdrop-blur-xl',
      'ring-stone-200/50', 'ring-stone-200/60',
      'bg-black/30', 'shadow-2xl', 'rounded-2xl',
      'focus:ring-stone-900/10', 'border-stone-200',
      // ... add any other classes used in app.js/addClient.js
    ],
    theme: { extend: { fontFamily: { sans: ['Inter', ...] } } }
  }
</script>
```

**Option B: Use Play CDN with content scan**

Switch to the Play CDN, which watches the DOM and can pick up dynamically added classes:

```html
<script src="https://cdn.tailwindcss.com?plugins=forms"></script>
```

(Play CDN scans the DOM; ensure modals are opened at least once so classes are present.)

**Option C: Build Tailwind properly (production)**

Use `npx tailwindcss -i ./src/input.css -o ./dist/output.css` with `content: ['./**/*.html', './**/*.js']` so all classes in HTML and JS are included. Requires a minimal build step.

**Option D: Verify classes in DevTools**

1. Open app, open a modal
2. Inspect modal elements
3. Check if Tailwind classes are on the elements
4. Check if corresponding CSS exists in the stylesheet (e.g. search for `backdrop-blur`)

If classes are present but have no effect, the CDN build may not include them. Use safelist or a proper build.

---

## 6. Zero-Cost Deployment Options

| Platform | Cost | Notes |
|----------|------|-------|
| **GitHub Pages** | Free | Push to repo, enable Pages; serves `index.html` + static files |
| **Netlify** | Free tier | Drag-and-drop or connect repo; auto-deploys |
| **Vercel** | Free tier | Connect repo; good for static sites |
| **Cloudflare Pages** | Free | Similar to above |

**Steps (e.g. GitHub Pages):**
1. Create GitHub repo, push project
2. Settings → Pages → Source: main branch, root
3. Ensure `index.html` is at repo root
4. Site URL: `https://<username>.github.io/<repo>/`

**Limitation:** localStorage is per-browser. Each device has its own data. For shared data, you’d need a backend later.

---

## 7. Quick Reference — Key Code Locations

| Task | File | Where |
|------|------|-------|
| Add table column | schema.json | `table_columns` array |
| Add form field | schema.json | `fields` object |
| Change date calc | dateEngine.js | `endOfCommitment`, `renewContact`, `calculateReviews` |
| Add modal | app.js | `modal.innerHTML = ...` pattern; use `#add-client-modal` |
| Add filter | app.js | `getVisible()`, `setupEvents()`, filter UI in index.html |
| Add sort | app.js | `getVisible()` switch, `table_columns` `sort_key` |
| Persist data | app.js | `saveClients()` → localStorage |

---

*End of context summary*
