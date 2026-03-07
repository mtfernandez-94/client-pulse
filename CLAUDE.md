# Client Pulse

## What
Local web dashboard for managing my online calisthenics coaching clients.

## Why
Replacing Google Sheets — it breaks when clients pause, can't clear renewal flags, and has no visual timeline.

## Key files
- `schema.json` — single source of truth for client data structure; table_columns drive the dashboard. Read before changing UI or data shape.
- `dateEngine.js` — all date calculations (pure functions); term_to_days and bonus_to_days come from schema, not hardcoded.
- `clients_seed.json` — seed data; app loads from localStorage first, fallback to seed.
- `planning_context.md` — business rules, decisions, backlog.

## Rules
- **Schema-first:** Add or change fields in schema.json first; table_columns and fields drive the app. Don't add columns or enums in app.js without schema.
- **Status is system-managed:** active / paused / archived. Never set status manually on add client; Archive/Reactivate and Pause/Resume are the only ways to change it.
- **Health:** Auto-assign "🆕 Onboarding" on add; editable via inline dropdown. On resume, restore from pause_history.health_before_pause.
- **Persistence:** All client changes save to localStorage; no separate clients.json write from the app.
