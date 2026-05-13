'use strict';

// ── analytics.js ──────────────────────────────────────────────────────────────
// Pure functions for churn, retention, and renewal metrics.
// All inputs are arrays of client objects + a `today` Date. No side effects.
// All metrics filter on archive.reason — only "churn" counts; "deferred" does not.

// Resolve the effective end date for a client: program_end_date overrides archived_at when set
function archiveEndDate(c) {
  return c.archive?.program_end_date || c.archive?.archived_at || null;
}

// Months a client lived: client_start → program_end_date (or archived_at, or today if active)
function lifetimeMonths(c, asOf) {
  const startStr = c.dates?.client_start || c.dates?.program_start;
  const start = parseDate(startStr);
  if (!start) return null;
  const endStr = archiveEndDate(c);
  const end = endStr ? parseDate(endStr) : (asOf || getToday());
  if (!end) return null;
  return daysDiff(start, end) / 30.4375;
}

function isChurnArchive(c) {
  return c.status === 'archived' && c.archive?.reason === 'churn' && !!c.archive?.archived_at;
}

// Was this client active (or paused) on a given date?
// Active if: client_start ≤ date AND (not archived OR program ended after date)
function wasActiveOnDate(c, date) {
  const start = parseDate(c.dates?.client_start || c.dates?.program_start);
  if (!start || start > date) return false;
  if (c.status === 'archived') {
    const endStr = archiveEndDate(c);
    if (endStr) {
      const ended = parseDate(endStr);
      if (ended && ended <= date) return false;
    }
  }
  return true;
}

function activeAtDate(clients, date) {
  return clients.filter(c => wasActiveOnDate(c, date)).length;
}

// Clients whose archive falls within [from, to], counted as churn only
// Uses program_end_date for window attribution when set, otherwise archived_at
function churnedInWindow(clients, from, to) {
  return clients.filter(c => {
    if (!isChurnArchive(c)) return false;
    const d = parseDate(archiveEndDate(c));
    return d && d >= from && d <= to;
  });
}

// Trailing 90-day churn: count + rate
// Rate = churned ÷ (active at start of window + acquired during window)
function trailing90DayChurn(clients, today) {
  const t = today || getToday();
  const start = addDays(t, -90);
  const churned = churnedInWindow(clients, start, t);
  const baseAtStart = activeAtDate(clients, start);
  const acquiredInWindow = clients.filter(c => {
    const cs = parseDate(c.dates?.client_start);
    return cs && cs >= start && cs <= t;
  }).length;
  const denom = baseAtStart + acquiredInWindow;
  const rate = denom > 0 ? (churned.length / denom) * 100 : 0;
  return { count: churned.length, rate, baseAtStart, acquiredInWindow, churned };
}

// Annualized rate: trailing 90d × 4 (rough, single-number forecast)
function annualizedChurnRate(clients, today) {
  const t90 = trailing90DayChurn(clients, today);
  if (t90.baseAtStart + t90.acquiredInWindow === 0) return null;
  return t90.rate * 4;
}

// Average client lifetime (months) across all churned clients
function avgLifetimeMonths(clients) {
  const churned = clients.filter(isChurnArchive);
  if (churned.length === 0) return null;
  const months = churned
    .map(c => lifetimeMonths(c, parseDate(c.archive.archived_at)))
    .filter(m => m != null && m >= 0);
  if (months.length === 0) return null;
  return months.reduce((s, m) => s + m, 0) / months.length;
}

// 12-month churn series: { label, shortLabel, count, activeAtStart, rate }
function monthlyChurnSeries(clients, today, months = 12) {
  const t = today || getToday();
  const series = [];
  for (let i = months - 1; i >= 0; i--) {
    const monthStart = new Date(t.getFullYear(), t.getMonth() - i, 1);
    const monthEnd   = new Date(t.getFullYear(), t.getMonth() - i + 1, 0);
    monthEnd.setHours(23, 59, 59, 999);
    const churned = churnedInWindow(clients, monthStart, monthEnd).length;
    const activeAtStart = activeAtDate(clients, monthStart);
    const rate = activeAtStart > 0 ? (churned / activeAtStart) * 100 : 0;
    series.push({
      year:          monthStart.getFullYear(),
      month:         monthStart.getMonth(),
      label:         monthStart.toLocaleDateString('en-AU', { month: 'long', year: 'numeric' }),
      shortLabel:    monthStart.toLocaleDateString('en-AU', { month: 'short' }),
      count:         churned,
      activeAtStart,
      rate,
    });
  }
  return series;
}

// Renewal rate over trailing N months: renewed ÷ (renewed + churned-via-renewal + paused-final)
function renewalRate(clients, today, months = 12) {
  const t = today || getToday();
  const cutoff = new Date(t.getFullYear(), t.getMonth() - months, t.getDate());
  let renewed = 0, decided = 0;
  clients.forEach(c => {
    const status = c.renewal?.status;
    const date = parseDate(c.renewal?.actioned_date);
    if (!status || status === 'pending') return;
    if (!date || date < cutoff) return;
    decided++;
    if (status === 'renewed') renewed++;
  });
  return {
    renewed,
    decided,
    rate: decided > 0 ? (renewed / decided) * 100 : 0,
  };
}

// Upcoming renewals: clients whose end_of_commitment falls in next 90d, bucketed
function upcomingRenewalsBuckets(clients, termToDays, bonusToDays, today) {
  const t = today || getToday();
  const detail = [];
  let next30 = 0, next60 = 0, next90 = 0;
  clients.forEach(c => {
    if (c.status !== 'active') return;
    const eoc = endOfCommitment(c, termToDays, bonusToDays);
    if (!eoc) return;
    const d = daysDiff(t, eoc);
    if (d < 0 || d > 90) return;
    let bucket;
    if (d <= 30)      { bucket = '0-30';  next30++; next60++; next90++; }
    else if (d <= 60) { bucket = '31-60'; next60++; next90++; }
    else              { bucket = '61-90'; next90++; }
    detail.push({ client: c, endDate: eoc, daysAway: d, bucket });
  });
  detail.sort((a, b) => a.daysAway - b.daysAway);
  return { next30, next60, next90, detail };
}
