'use strict';

// ── dateEngine.js ─────────────────────────────────────────────────────────────
// Single source of all date calculations for Client Pulse.
// All functions are pure: given the same input, they return the same output.
// termToDays and bonusToDays are passed in from schema.json — nothing is hardcoded.
//
// Review schedule (from schema.json):
//   Review 1: program_start + 49 days  (week 7)
//   Review 2: program_start + 105 days (week 15)
//   Review 3: program_start + 161 days (week 23)
//   Review 4: program_start + 217 days (week 31)
//   Review 5: program_start + 273 days (week 39)
//   Review 6: program_start + 329 days (week 47)
//   Each review is only included if it falls before end_of_commitment.

const REVIEW_OFFSETS = [49, 105, 161, 217, 273, 329]; // days from program_start

const TODAY = new Date();
TODAY.setHours(0, 0, 0, 0);

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

// End of Commitment = program_start + term_days + bonus_days + (weeks_paused × 7)
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

// Calculate all review dates live from program_start.
// Only includes reviews that fall before end_of_commitment.
// Returns an array of { reviewNum, date, completed, completed_date, notes }
function calculateReviews(c, termToDays, bonusToDays) {
  const start = parseDate(c.dates?.program_start);
  const eoc   = endOfCommitment(c, termToDays, bonusToDays);
  if (!start || !eoc) return [];

  const pauseDays = (c.dates?.weeks_paused || 0) * 7;
  const stored    = c.reviews || {};

  return REVIEW_OFFSETS.map((offset, i) => {
    const reviewNum  = i + 1;
    const reviewDate = addDays(start, offset + pauseDays);

    // Only include this review if it falls within the commitment period
    if (reviewDate >= eoc) return null;

    // Merge with any stored completion data
    const key      = `review_${reviewNum}`;
    const existing = stored[key] || {};

    return {
      reviewNum,
      date:           reviewDate,
      completed:      existing.completed || false,
      completed_date: existing.completed_date || null,
      notes:          existing.notes || null,
    };
  }).filter(Boolean);
}

// Next upcoming review: earliest uncompleted review from today onwards
function nextReview(c, termToDays, bonusToDays) {
  return calculateReviews(c, termToDays, bonusToDays)
    .filter(r => !r.completed)
    .map(r => r.date)
    .sort((a, b) => a - b)[0] || null;
}

// ── Flag calculations ─────────────────────────────────────────────────────────

function renewalFlag(c, termToDays, bonusToDays) {
  if (c.renewal?.status !== 'pending') return null;
  const rc = renewContact(c, termToDays, bonusToDays);
  if (!rc) return null;
  const d = daysDiff(TODAY, rc);
  if (d < 0)  return 'overdue';
  if (d <= 7) return 'soon';
  return null;
}

function reviewFlag(c, termToDays, bonusToDays) {
  const nr = nextReview(c, termToDays, bonusToDays);
  if (!nr) return null;
  const d = daysDiff(TODAY, nr);
  if (d < 0)  return 'overdue';
  if (d <= 7) return 'soon';
  return null;
}

function urgencyScore(c, termToDays, bonusToDays) {
  const f = renewalFlag(c, termToDays, bonusToDays);
  if (f === 'overdue') return 0;
  if (f === 'soon')    return 1;
  const rc = renewContact(c, termToDays, bonusToDays);
  if (rc) return 2 + daysDiff(TODAY, rc);
  return 99999;
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
