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

### 2026-10-16 — Reviews removed, month-to-month added
- **Reviews removed entirely:** Next Review column, Reviews Due KPI, review modal, edit-modal Reviews section, Actions "Reviews" card, Gantt review dots, command-center `review` action, `reviews` field in schema/supabase.js/seed. DB column dropped via `remove-reviews-migration.sql` (run after deploy).
- **Month-to-month term (`M2M`):** `term_to_days.M2M = null` marks a rolling term → `isRollingTerm()`; no end of commitment / renewal contact. Table shows "↻ Rolling"; Gantt draws a dashed bar to the right edge that fades out (archived M2M stops at program end / archive date). Dropdowns show "Month-to-month" via schema `labels`.
- **Missing-data warning** moved from the review column to Renew Contact (`diagnoseMissingDates()`).
- **Fix — contract edits no longer revert on reload:** term/bonus/program_start/payment are rebuilt from `contract_history` on every load, but the edit modal, reactivate, inline program-start edit and Command Center program_start/renewal wrote them directly. They now log an event via `contractSnapshot()` + `logContractEdit()` (`edit` or `renew`).
- **Password reset:** "Forgot password?" on the login screen and "Forgot it?" in Change Password email a reset link (`sbSendPasswordReset`, redirect = site origin). Arriving via the link sets recovery mode (`type=recovery` hash / `PASSWORD_RECOVERY` event → `sbInRecovery()`), which opens "Set a New Password" without asking for the old one.
- **Team access (VA logins):** `coach_members` + `can_access_coach()` RLS via `team-access-migration.sql`; app resolves `activeCoachId` with `sbResolveCoachId()` (falls back to own id while the table doesn't exist). `sbSaveClient` now throws when RLS silently updates 0 rows, so lost access shows a toast instead of saves vanishing.

---

## 3. Next Steps (Prioritised)

### ~~1. Clickable Review Flags~~ ✗ **dropped** · 2026-10-16 — review feature removed

### ~~2. Supabase RLS Verification~~ ✓ **complete** · 2026-10-16 — `team-access-migration.sql` run; old policies were 4× `coach_id = auth.uid()` (snapshot in `team-access-rollback.sql`); coach verified to see 44/44 rows, anon sees 0
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
| **gantt.js** | Gantt timeline rendering | Health-colored bars, renewal markers, dashed open-ended month-to-month bars |
| **clients_seed.json** | Backup seed data | Used as fallback import when Supabase is empty |

### Data Flow

```
schema.json ──► tableColumns, termToDays, bonusToDays
                    │
Supabase (clients table) ──► sbLoadClients(coachId) ──► allClients[]
                    │
                    ▼
              dateEngine.js (endOfCommitment, renewContact, isRollingTerm, renewalFlag)
                    │
                    ▼
              app.js: getVisible(), render(), renderCell(), modals
```

### Key Patterns

1. **Schema-first:** Add `table_columns` entry → column appears. Add enum option → dropdown updates.
2. **Status:** `active` | `paused` | `archived` — only changed via Pause/Resume, Archive/Reactivate.
3. **Health:** Auto "🆕 Onboarding" on add; editable inline; on resume, restored from `pause_history.health_before_pause`.
4. **Calculated fields:** `calc.end_of_commitment`, `calc.renew_contact` — dispatched in `getCalc()` in app.js, call dateEngine with `termToDays`, `bonusToDays`. Both are null for rolling (month-to-month) terms.
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
- `calc_date` — from getCalc; "↻ Rolling" for month-to-month
- `renewal_flag` — clickable when pending, opens renewal modal; "⚠ Missing data" when dates can't be calculated

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
| Change date calc | dateEngine.js | `endOfCommitment`, `renewContact`, `isRollingTerm` |
| Add modal | app.js | `modal.innerHTML = ...` pattern; use `#add-client-modal` |
| Add filter | app.js | `getVisible()`, `setupEvents()`, filter UI in index.html |
| Add sort | app.js | `getVisible()` switch, `table_columns` `sort_key` |
| Persist data | supabase.js | `sbSaveClient()`, `sbInsertClient()` |
| Backup/restore | app.js | `exportBackupJSON()`, `importBackupJSON()` |

---

*End of context summary*
