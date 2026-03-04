# Planning Context — Decisions Made

This file captures the key decisions from the planning conversation so Claude Code has full context without needing the original chat history.

## Why this project exists
- Student is a non-technical calisthenics coach replacing a Google Sheets client management system
- Current spreadsheet breaks when pausing clients, can't clear renewal flags, no visual timeline
- The project doubles as a Claude Code learning exercise — every sprint teaches a new feature
- Goal: build a tool they'll use daily while learning to ship products with AI

## Key decisions made during planning

### Architecture
- **Schema-driven design**: schema.json is the single source of truth. Adding a field to the schema should automatically update the UI. This was the student's #1 requirement — "everything should be tweakable without anything breaking."
- **Local-first**: JSON file storage, no database, no hosting costs. Runs on localhost or free static hosting.
- **Modular code**: each feature in its own file. Date engine, pause system, reviews, gantt — all independent.

### Data decisions
- **Two date fields**: client_start (never changes, tracks when they first signed up) and program_start (resets each term). The spreadsheet only had one date, which broke renewal tracking.
- **Review completion**: reviews must be markable as done so flags clear. The spreadsheet couldn't do this — overdue reviews stayed flagged forever.
- **Renewal outcomes**: renewals tracked as pending → actioned (renewed/churned/paused). Not just a date flag.
- **Pause history**: full log of when, how long, why — not just a number.

### Teaching approach
- Pause after each concept, quiz the student, hold them to a high bar
- Build first, label the concept second
- Use coaching analogies (progressions, periodisation, protocols)
- Claude Code acts as both teacher and code agent in the same session

### Student preferences
- Bullet points and structured output preferred
- Explain the "why" — first principles thinking
- Challenge manual assumptions
- Proactively suggest improvements but don't over-suggest
- Keep it scrappy and low-cost

### Business context for copilot suggestions
- Currently $7-10K/month AUD, targeting $50K/month
- ~20 active clients, 3 paused, ~19 archived
- Biggest bottleneck: writing programmes (4-week cycles) and reviewing form-check videos
- VA handles 50 Instagram DM conversations/day
- Uses EverFit for programme delivery, Stripe for payments
- Australian domiciled (GST applies to AU clients at 10%)

## Files in this project
| File | Purpose |
|------|---------|
| CLAUDE.md | Project context for Claude Code — always loaded |
| curriculum.md | Sprint-by-sprint lesson plan — Claude Code reads and follows this |
| schema.json | Single source of truth for client data structure |
| clients_seed.json | Real client data exported from spreadsheet (40 clients) |
| settings_reference.json | Allow/deny permissions reference |
| planning_context.md | This file — decisions from the planning conversation |
