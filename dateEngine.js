'use strict';

// ── dateEngine.js ─────────────────────────────────────────────────────────────
// Single source of all date calculations for Client Pulse.
// All functions are pure: given the same input, they return the same output.
// termToDays and bonusToDays are passed in from schema.json — nothing is hardcoded.
// A term mapped to null in termToDays is rolling (month-to-month): it has no
// end of commitment and no renewal contact.

// Returns today at midnight, local time. Called fresh each time so tabs open
// overnight always use the current date (not a stale value from page load).
function getToday() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}

// Local-timezone ISO string (YYYY-MM-DD). Uses local date, not UTC,
// so 10 PM in AEST returns today's date, not yesterday's.
function todayISO() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

// ── Pure date utilities ───────────────────────────────────────────────────────

function parseDate(str) {
  if (!str || typeof str !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(str)) return null;
  const d = new Date(str + 'T00:00:00');
  return isNaN(d.getTime()) ? null : d;
}

function addDays(date, n) {
  const d = new Date(date);
  d.setDate(d.getDate() + n);
  return d;
}

function daysDiff(from, to) {
  return Math.round((to - from) / 86400000);
}

function fmt(date) {
  if (!date) return '—';
  return date.toLocaleDateString('en-AU', { day: 'numeric', month: 'short', year: '2-digit' });
}

// ── Core calculations ─────────────────────────────────────────────────────────

// Rolling term (month-to-month): listed in termToDays with a null length.
function isRollingTerm(c, termToDays) {
  const term = c.contract?.term;
  return !!term && term in termToDays && termToDays[term] === null;
}

// End of Commitment = program_start + term_days + bonus_days + (weeks_paused × 7)
// Rolling terms have no end, so this returns null for them.
function endOfCommitment(c, termToDays, bonusToDays) {
  const start = parseDate(c.dates?.program_start);
  if (!start) return null;
  const termDays  = termToDays[c.contract?.term] || 0;
  if (!termDays) return null;
  const bonusDays = bonusToDays[c.contract?.bonus_term] || 0;
  const pauseDays = (c.dates?.weeks_paused || 0) * 7;
  return addDays(start, termDays + bonusDays + pauseDays);
}

// Renew Contact = end_of_commitment − 37 days
function renewContact(c, termToDays, bonusToDays) {
  const eoc = endOfCommitment(c, termToDays, bonusToDays);
  return eoc ? addDays(eoc, -37) : null;
}

// ── Flag calculations ─────────────────────────────────────────────────────────

function renewalFlag(c, termToDays, bonusToDays) {
  if (c.renewal?.status !== 'pending') return null;
  const rc = renewContact(c, termToDays, bonusToDays);
  if (!rc) return null;
  const d = daysDiff(getToday(), rc);
  if (d < 0)  return 'overdue';
  if (d <= 7) return 'soon';
  return null;
}

function urgencyScore(c, termToDays, bonusToDays) {
  const f = renewalFlag(c, termToDays, bonusToDays);
  if (f === 'overdue') return 0;
  if (f === 'soon')    return 1;
  const rc = renewContact(c, termToDays, bonusToDays);
  if (rc) return 2 + daysDiff(getToday(), rc);
  return 99999;
}

// ── Date diagnostic ───────────────────────────────────────────────────────────
// Returns a human-readable reason why commitment/renewal dates can't be
// calculated, or null if data is fine. Rolling terms only need a program start.
function diagnoseMissingDates(c, termToDays) {
  if (!parseDate(c.dates?.program_start)) return 'Missing or invalid program start date';
  if (isRollingTerm(c, termToDays)) return null;
  if (!termToDays[c.contract?.term]) return `Missing or invalid contract term: "${c.contract?.term || '(empty)'}"`;
  return null;
}

// ── Contract history projection ───────────────────────────────────────────────
// Walks contract_history sorted by event_date (then logged_at for ties),
// forward-applies each event's non-undefined fields, and writes the projected
// state back onto client.contract / client.payment / client.dates.program_start.
// Voided events and future-dated events are excluded.
// Call this after loading clients. It is safe to call multiple times (idempotent).

function projectContractState(client) {
  const history = client.contract_history;
  if (!history || history.length === 0) return;

  const today = todayISO();

  const sorted = [...history]
    .filter(ev => !ev.voided && ev.event_date <= today)
    .sort((a, b) => {
      const d = a.event_date.localeCompare(b.event_date);
      return d !== 0 ? d : (a.logged_at || '').localeCompare(b.logged_at || '');
    });

  if (sorted.length === 0) return;

  let term, bonus_term, program_start;
  let period, amount, currency, gst, processor;

  for (const ev of sorted) {
    if ('term'          in ev && ev.term         !== null) term          = ev.term;
    if ('bonus_term'    in ev)                             bonus_term    = ev.bonus_term; // null = explicit clear
    if ('program_start' in ev && ev.program_start !== null) program_start = ev.program_start;
    if (ev.payment) {
      const p = ev.payment;
      if ('period'    in p && p.period    !== null) period    = p.period;
      if ('amount'    in p && p.amount    !== null) amount    = p.amount;
      if ('currency'  in p && p.currency  !== null) currency  = p.currency;
      if ('gst'       in p)                         gst       = p.gst;
      if ('processor' in p && p.processor !== null) processor = p.processor;
    }
  }

  client.contract = client.contract || {};
  client.payment  = client.payment  || {};
  client.dates    = client.dates    || {};

  if (term          !== undefined) client.contract.term       = term;
  if (bonus_term    !== undefined) client.contract.bonus_term = bonus_term;
  if (program_start !== undefined) client.dates.program_start = program_start;
  if (period        !== undefined) client.payment.period    = period;
  if (amount        !== undefined) client.payment.amount    = amount;
  if (currency      !== undefined) client.payment.currency  = currency;
  if (gst           !== undefined) client.payment.gst       = gst;
  if (processor     !== undefined) client.payment.processor = processor;
}

// ── Health normalisation ──────────────────────────────────────────────────────
// Spreadsheet export has inconsistent spacing/emoji — normalise to canonical values

function normaliseHealth(h) {
  if (!h) return null;
  const s = h.trim().replace(/\s+/g, ' ');
  if (s.includes('Onboarding')) return '🆕 Onboarding';
  if (s.includes('Momentum'))  return '✅ Momentum';
  if (s.includes('Cruising'))  return '🔸 Cruising';
  if (s.includes('Attention')) return '🚩 Attention';
  if (s.includes('Pause'))     return '⏸️ Pause';
  return s;
}
