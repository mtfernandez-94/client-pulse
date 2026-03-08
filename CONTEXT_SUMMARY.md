# Client Pulse — Context Summary for Claude Code

**Purpose:** Paste this into a new Claude Code session to restore full context. Last updated: March 2026.

---

## 1. Project Overview

**Client Pulse** is a live web dashboard for managing online calisthenics coaching clients. It replaces Google Sheets, which broke when clients paused, couldn't clear renewal flags, and had no visual timeline.

- **Stack:** Vanilla HTML/JS, Tailwind CDN, no build system, no framework
- **Hosting:** GitHub Pages at `pulse.whytbelt.com` (custom domain via GoDaddy CNAME)
- **Data:** Supabase (PostgreSQL + auth + Row Level Security)
- **Repo:** `github.com/mtfernandez-94/client-pulse` → deploys on push to `main`

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

### Sprint 6 (Review & Renewal)
- **Reviews:** In edit modal, list of calculated reviews; "Mark complete" → sets `reviews.review_N.completed = true`, `completed_date`
- **Renewals:** Click Renew Contact cell (when pending) → modal with outcome (renewed/churned/paused), notes, new program_start if renewed

### Sprint 7 (Gantt)
- Table/Gantt toggle; custom CSS timeline (no library)
- Bars colour-coded by health; today line; amber = renew contact, indigo dots = reviews; click bar → edit modal

### Sprint 8 (Archive/Reactivate)
- Archive: `status → archived`; Reactivate: new `program_start` (+ optional term) → `status active`, `health Onboarding`, `renewal pending`

### Sprint 9 (Supabase Migration)
- Replaced localStorage with Supabase backend (PostgreSQL)
- Auth: email/password via `supabase-js` CDN
- Data: `clients` table with `coach_id` foreign key, Row Level Security
- One-time migration: on login, if localStorage has data and Supabase is empty, auto-migrates
- Functions: `sbLoadClients(coachId)`, `sbSaveClient()`, `sbInsertClient()`, `sbSeedClients()`

### Sprint 10 (UI Redesign — "Obsidian")
- **Design system:** Space Grotesk (UI) + JetBrains Mono (data), indigo accent (#818cf8)
- **3D depth system:** `.depth-1/2/3` layered box-shadows, `.glass` panels, `.modal-panel`
- **KPI cards:** 6 floating 3D cards with colored accent strips + radial underglow
- **Health distribution bar:** Proportional colored segments below KPI row
- **Table:** Health-colored inset glow strips on every row
- **Gantt:** 3D gradient bars, indigo today line, indigo review dots
- **Inputs:** 3D recessed with inset shadows; buttons with gradient + press states

### Backlog (Done)
- Sort by all columns; payment sorts by currency then amount; Period column sorts by payment type
- Processor column added to schema `table_columns`
- Export CSV
- JSON backup export + import (prevents future data loss)

---

## 3. Next Steps (Prioritised)

### 1. Clickable Review Flags
- Reviews: currently "Mark complete" in edit modal only
- **Goal:** Make overdue/upcoming reviews clickable in the table (like Renew Contact), open a dedicated "Complete review" modal

### 2. Supabase RLS Verification
- Verify RLS policy on `clients` table uses `coach_id = auth.uid()`
- App-level filter added as defense-in-depth, but RLS is the real security layer

---

## 4. Current Architecture & Where to Find Things

### File Map

| File | Purpose | Claude Should |
|------|---------|---------------|
| **CLAUDE.md** | Project context, rules, key files | Read first; contains schema-first, status/health rules |
| **schema.json** | Single source of truth for data structure | Edit here to add columns, enums, fields; UI adapts |
| **planning_context.md** | Business rules, decisions, backlog | Reference for "why" and future features |
| **index.html** | App shell, header, controls, table/gantt containers, modal div | Add new UI containers or scripts here |
| **app.js** | Main app: render, filter, sort, edit modal, pause, renewal, archive, backup/import | Core logic; add features here |
| **addClient.js** | Add-client modal, validation, submit | Add-client flow only |
| **dateEngine.js** | Pure date calculations | Read for date logic; don't hardcode term/bonus days |
| **supabase.js** | Supabase client, auth, CRUD operations | All DB reads/writes go through here |
| **gantt.js** | Gantt timeline rendering | Health-colored bars, review/renewal markers |
| **clients_seed.json** | Backup seed data | Used as fallback import when Supabase is empty |

### Data Flow

```
schema.json ──► tableColumns, termToDays, bonusToDays
                    │
Supabase (clients table) ──► sbLoadClients(coachId) ──► allClients[]
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
6. **Auth:** Supabase email/password. Session checked on init. coach_id = user.id.
7. **Backup:** JSON export/import in header. Export strips Supabase IDs; import seeds via `sbSeedClients()`.

### Global State (app.js)

```js
allClients, tableColumns, termToDays, bonusToDays, schemaCache
filterStatus, filterHealth, filterTerm, sortCol, sortDir, viewMode
```

### Functions to Reuse

- `getPath(obj, path)` — dot-notation lookup
- `parseDate(str)`, `addDays`, `daysDiff`, `fmt` — in dateEngine.js (global)
- `todayISO()` — in app.js
- `sbLoadClients(coachId)`, `sbSaveClient()`, `sbInsertClient()` — in supabase.js
- `openEditModal(idx)`, `closeModal()` — edit modal
- `render()`, `renderStats()` — refresh UI
- `exportBackupJSON()`, `importBackupJSON()` — data backup/restore

### Cell Types (schema.json `cell_type`)

- `name` — clickable, opens edit
- `health_badge` — inline dropdown
- `status_badge` — read-only badge
- `text`, `date` — display
- `payment` — custom payment cell
- `calc_date` — from getCalc
- `renewal_flag` — clickable when pending, opens renewal modal
- `review_flag` — display only (backlog: make clickable like renewals)

---

## 5. Deployment

| Setting | Value |
|---------|-------|
| **Hosting** | GitHub Pages (free) |
| **Repo** | `github.com/mtfernandez-94/client-pulse` |
| **Branch** | `main` (auto-deploys on push) |
| **Custom domain** | `pulse.whytbelt.com` (CNAME in GoDaddy → `mtfernandez-94.github.io`) |
| **HTTPS** | Enforced via GitHub Pages |
| **Backend** | Supabase (free tier) |
| **Auth** | Supabase email/password |
| **Database** | Supabase PostgreSQL with RLS |

---

## 6. Quick Reference — Key Code Locations

| Task | File | Where |
|------|------|-------|
| Add table column | schema.json | `table_columns` array |
| Add form field | schema.json | `fields` object |
| Change date calc | dateEngine.js | `endOfCommitment`, `renewContact`, `calculateReviews` |
| Add modal | app.js | `modal.innerHTML = ...` pattern; use `#add-client-modal` |
| Add filter | app.js | `getVisible()`, `setupEvents()`, filter UI in index.html |
| Add sort | app.js | `getVisible()` switch, `table_columns` `sort_key` |
| Persist data | supabase.js | `sbSaveClient()`, `sbInsertClient()` |
| Backup/restore | app.js | `exportBackupJSON()`, `importBackupJSON()` |

---

*End of context summary*
