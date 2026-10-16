# Client Pulse

## What This Workspace Is

Client Pulse is a live web dashboard for managing online calisthenics coaching clients — tracking health, contracts, renewals, and timelines via a Gantt chart. It feeds directly from the coaching business (clients onboard → managed here) and replaces a broken Google Sheets workflow. Output is a clear, actionable view of which clients need attention right now.

**Stack:** Vanilla HTML/JS + Tailwind CDN · Supabase (PostgreSQL + Auth) · GitHub Pages · No build step  
**Live:** `pulse.whytbelt.com` → GitHub Pages auto-deploy on push to `main`

---

## What to Load

| Task | Load These | Skip These |
|------|-----------|------------|
| UI change (table, badges, modals) | `schema.json`, `app.js`, `index.html` | `planning_context.md`, seed data |
| Date/calculation logic | `dateEngine.js`, `schema.json` | `gantt.js`, `supabase.js` |
| Database / auth change | `supabase.js`, `schema.json` | `gantt.js`, `addClient.js` |
| Gantt chart work | `gantt.js`, `index.html`, `app.js` (HEALTH_STYLES_BY_INDEX) | `supabase.js`, `addClient.js` |
| Add client form | `addClient.js`, `schema.json` | `gantt.js` |
| Understanding product decisions | `planning_context.md`, `CONTEXT_SUMMARY.md` | Source files |
| Debugging / orientation | `CONTEXT_SUMMARY.md` then targeted files | `clients_seed.json` |

---

## Folder Structure

```
client-pulse/
├── CONTEXT.md              ← You are here
├── CLAUDE.md               ← Claude Code project card (rules)
├── CONTEXT_SUMMARY.md      ← Quick-reference index
├── planning_context.md     ← Business decisions, backlog, sprint history
├── curriculum.md           ← Sprint lessons log
│
├── index.html              ← App shell, layout, all CDN links
├── app.js                  ← Core logic (~113KB): state, render, modals, events
├── addClient.js            ← Add-client modal and form submit
├── dateEngine.js           ← Pure date calculation functions (no side effects)
├── supabase.js             ← All DB CRUD and auth (only file that touches Supabase SDK)
├── gantt.js                ← Gantt chart renderer (CSS-based, zoom, markers)
│
├── schema.json             ← SINGLE SOURCE OF TRUTH: columns, fields, enums, term lookups
├── clients_seed.json       ← Seed/backup data (17KB, 17 clients)
├── settings_reference.json ← Reference for .claude/settings.json permissions
├── remove-reviews-migration.sql ← Drops the old `reviews` column (run after deploy)
├── team-access-migration.sql ← VA/team logins: coach_members + clients RLS; add/remove VA
│
├── CNAME                   ← Custom domain (pulse.whytbelt.com)
├── .nojekyll               ← GitHub Pages static site flag
├── favicon.svg
├── keepalive/              ← Supabase keep-alive (own private repo, git-ignored here)
├── .claude/                ← Claude Code permissions and launch config
└── .cursor/                ← Cursor hooks (session-start, format validation)
```

---

## The Process

### How the app works

```
User opens pulse.whytbelt.com
  └─ index.html loads scripts in order:
       dateEngine.js → supabase.js → addClient.js → gantt.js → app.js (last)
           │
           ▼
       init() in app.js
           ├─ Load schema.json → tableColumns, termToDays, bonusToDays
           ├─ sbGetSession() → check auth
           └─ sbLoadClients(coachId) → allClients[]
                   │
                   ▼
               render()
                   ├─ getVisible() → apply filters + sort
                   └─ renderCell(col, client) → cell_type decides HTML
                           │
               User action → modal → save → sbSaveClient() → render()
```

### Schema-first development rule

**All changes start in `schema.json`.** Adding a column or field there auto-adapts the table, form, and filters — no app.js changes needed for basic fields.

### Calculated fields rule

`end_of_commitment` and `renew_contact` are **never stored in the DB** — always calculated live from `program_start + term + bonus_term + weeks_paused`.

### Month-to-month terms

Term `M2M` is rolling: `term_to_days` maps it to `null`, which `isRollingTerm()` reads. Rolling clients have no end of commitment and no renewal contact (never flagged). The Gantt draws them as a dashed bar that runs off the right edge and fades out; archived ones stop at program end / archive date. Switching between M2M and a fixed term in Update Terms restarts `program_start` on the effective date.

### Team access (VA logins)

A team member (e.g. the VA) signs in with their **own** account and works on the coach's clients. `coach_members` maps `member_id → coach_id`. On load, `sbResolveCoachId()` returns the coach's id for a member, else the user's own id. The result is stored in `activeCoachId` and used for every load, save and insert. RLS (`can_access_coach()`) lets the coach and their members read, add and edit. Only the coach can delete, and logged-out users see nothing. Set up and manage it with `team-access-migration.sql`:
1. Run the migration once in the Supabase SQL editor (the app works before and after).
2. The VA clicks **Create Account** on pulse.whytbelt.com and confirms their email.
3. Run the "Give the VA access" insert from the bottom of the file with both emails.
4. To remove access, run the delete from the same file. It takes effect immediately; their saves fail with "no access" and a reload shows an empty dashboard.

Reviews were removed on 2026-10-16. `reviews` is no longer read or written, and `remove-reviews-migration.sql` drops the column. Run it only after the new app version is deployed.

### Status is system-managed

`status` is never set by the user. Only system operations change it: Add → `active`, Pause → `paused`, Resume → `active`, Archive → `archived`.

### Deployment

```
git push origin main  →  GitHub Pages builds & deploys (~1 min)
```

### Supabase keep-alive

Free-plan Supabase pauses after 7 days of low activity. A GitHub Action in the private repo `mtfernandez-94/client-pulse-keepalive` (local copy: `keepalive/`) runs every 5 days and makes 3 read-only `select id … limit 1` queries with the public anon key — RLS returns 0 rows, so no client data is read or changed. Failure emails the repo owner; a 540/503 means the project is already paused (resume in the Supabase dashboard). Lives in its own private repo because GitHub disables scheduled workflows in public repos after 60 days without a push. Details: `keepalive/README.md`.

---

## Skills & Tools

| Skill / Tool | When | Purpose |
|--------------|------|---------|
| Supabase dashboard | Verifying RLS policies, schema, data | DB inspection and admin |
| Browser DevTools | Debugging render, auth, network | Live debugging in-app |
| GitHub Pages | Viewing live deploys | Check production state |

### Key patterns to follow

| Rule | Why |
|------|-----|
| Read `schema.json` before any UI change | It's the source of truth; hardcoding enums breaks the schema-first contract |
| Use `dateEngine` functions — never raw `new Date()` math | Handles pause offsets, AU locale, midnight rollover edge cases |
| All DB calls go through `supabase.js` | app.js must never call Supabase SDK directly |
| Never persist calculated fields | They're always re-derived; storing them causes stale data bugs |
| Use `getPath(obj, 'payment.amount')` for nested access | Handles missing fields gracefully |
| Modals: one `div#add-client-modal`, rewrite innerHTML | Pattern already established; keeps HTML simple |

---

## What NOT to Do

- **Don't hardcode enum values** in app.js — they live in `schema.json`
- **Don't store `end_of_commitment` or `renew_contact`** in Supabase — calculated fields only
- **Don't use `session.user.id` as the coach id** — use `activeCoachId`; for a VA they differ, and saving with the VA's id would move clients onto their account
- **Don't hardcode `'M2M'`** — check `isRollingTerm()` (driven by `term_to_days: null`)
- **Don't write term / bonus / program_start / payment directly** without logging it — they're rebuilt from `contract_history` on load. Snapshot with `contractSnapshot()`, apply, then `logContractEdit()`
- **Don't add `status` transitions** outside of Pause / Resume / Archive / Reactivate / Add
- **Don't call Supabase SDK** directly from app.js — always through `supabase.js`
- **Don't change script load order** in index.html — `app.js` must be last
- **Don't use a JS framework** — vanilla JS is intentional; no build step is a feature, not a gap
- **Don't add columns to the table** without first defining them in `schema.json`
