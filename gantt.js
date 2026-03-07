'use strict';

// ── gantt.js ──────────────────────────────────────────────────────────────────
// ClickUp-style Gantt chart with scrollable timeline, zoom, and hover tooltips.
// Reads from globals: allClients, termToDays, bonusToDays, schemaCache, getToday()
// Calls: getVisible(), endOfCommitment(), renewContact(), calculateReviews(),
//        parseDate(), daysDiff(), fmt(), openEditModal()

// ── Config ────────────────────────────────────────────────────────────────────

const GANTT_LABEL_W   = 200;      // left column width (px)
const GANTT_ROW_H     = 40;       // row height (px)
const GANTT_BAR_H     = 24;       // bar height within row
const GANTT_MIN_ZOOM  = 2;        // px per day (zoomed out)
const GANTT_MAX_ZOOM  = 40;       // px per day (zoomed in)
const GANTT_DEFAULT_ZOOM = 8;     // px per day

let ganttZoom = GANTT_DEFAULT_ZOOM;
let ganttRangeStart = null;
let ganttRangeEnd = null;
let ganttScrollEl = null;          // reference to scroll container

// GANTT_BAR_COLOR is built in app.js init() from schema + HEALTH_STYLES_BY_INDEX.
// Declared here so gantt.js can reference it; populated before first render.
let GANTT_BAR_COLOR = {};
const GANTT_DEFAULT_COLOR = { bg: '#f3f4f6', border: '#d1d5db', text: '#6b7280' };

// ── Zoom helpers ──────────────────────────────────────────────────────────────

function ganttZoomIn() {
  const prev = ganttZoom;
  ganttZoom = Math.min(ganttZoom * 1.4, GANTT_MAX_ZOOM);
  adjustScrollAfterZoom(prev);
  renderGantt();
}

function ganttZoomOut() {
  const prev = ganttZoom;
  ganttZoom = Math.max(ganttZoom / 1.4, GANTT_MIN_ZOOM);
  adjustScrollAfterZoom(prev);
  renderGantt();
}

function adjustScrollAfterZoom(prevZoom) {
  if (!ganttScrollEl) return;
  const ratio = ganttZoom / prevZoom;
  const midScroll = ganttScrollEl.scrollLeft + ganttScrollEl.clientWidth / 2;
  requestAnimationFrame(() => {
    if (ganttScrollEl) {
      ganttScrollEl.scrollLeft = midScroll * ratio - ganttScrollEl.clientWidth / 2;
    }
  });
}

// ── Date header ───────────────────────────────────────────────────────────────

function buildDateHeader(rangeStart, rangeDays, pxPerDay) {
  const totalW = rangeDays * pxPerDay;

  // Decide subdivision level based on zoom
  let mode = 'months'; // default: month labels
  if (pxPerDay >= 6) mode = 'weeks';
  if (pxPerDay >= 20) mode = 'days';

  let topRow = '';  // major: months or weeks
  let botRow = '';  // minor: weeks or days

  if (mode === 'months') {
    // Top: months, Bottom: week ticks
    let cur = new Date(rangeStart);
    while (cur < new Date(rangeStart.getTime() + rangeDays * 86400000)) {
      const monthStart = new Date(cur.getFullYear(), cur.getMonth(), 1);
      const monthEnd = new Date(cur.getFullYear(), cur.getMonth() + 1, 0);
      const startDay = Math.max(0, daysDiff(rangeStart, cur));
      const endDay = Math.min(rangeDays, daysDiff(rangeStart, monthEnd) + 1);
      const w = (endDay - startDay) * pxPerDay;
      const label = cur.toLocaleDateString('en-AU', { month: 'short', year: '2-digit' });
      topRow += `<div class="flex-shrink-0 border-r border-stone-200 text-[11px] font-semibold text-stone-500 uppercase tracking-wider px-2 flex items-center" style="width:${w}px;height:24px;">${w > 40 ? label : ''}</div>`;
      cur = new Date(cur.getFullYear(), cur.getMonth() + 1, 1);
    }
    // Bottom: week ticks
    let d = new Date(rangeStart);
    // Advance to next Monday
    while (d.getDay() !== 1) d = new Date(d.getTime() + 86400000);
    while (d < new Date(rangeStart.getTime() + rangeDays * 86400000)) {
      const offset = daysDiff(rangeStart, d);
      const left = offset * pxPerDay;
      botRow += `<div class="absolute border-l border-stone-100" style="left:${left}px;height:100%;top:0;"></div>`;
      d = new Date(d.getTime() + 7 * 86400000);
    }
  } else if (mode === 'weeks') {
    // Top: month labels, Bottom: week labels with day number
    let cur = new Date(rangeStart);
    while (cur < new Date(rangeStart.getTime() + rangeDays * 86400000)) {
      const monthStart = new Date(cur.getFullYear(), cur.getMonth(), 1);
      const monthEnd = new Date(cur.getFullYear(), cur.getMonth() + 1, 0);
      const startDay = Math.max(0, daysDiff(rangeStart, cur));
      const endDay = Math.min(rangeDays, daysDiff(rangeStart, monthEnd) + 1);
      const w = (endDay - startDay) * pxPerDay;
      const label = cur.toLocaleDateString('en-AU', { month: 'short', year: '2-digit' });
      topRow += `<div class="flex-shrink-0 border-r border-stone-200 text-[11px] font-semibold text-stone-500 uppercase tracking-wider px-2 flex items-center" style="width:${w}px;height:24px;">${label}</div>`;
      cur = new Date(cur.getFullYear(), cur.getMonth() + 1, 1);
    }
    // Week columns
    let d = new Date(rangeStart);
    while (d.getDay() !== 1) d = new Date(d.getTime() + 86400000);
    while (d < new Date(rangeStart.getTime() + rangeDays * 86400000)) {
      const offset = daysDiff(rangeStart, d);
      const left = offset * pxPerDay;
      const weekW = 7 * pxPerDay;
      const label = d.getDate();
      botRow += `<div class="absolute text-[10px] text-stone-400 border-l border-stone-100 px-1" style="left:${left}px;width:${weekW}px;top:0;height:100%;">${label}</div>`;
      d = new Date(d.getTime() + 7 * 86400000);
    }
  } else {
    // Top: week ranges, Bottom: individual days
    let cur = new Date(rangeStart);
    while (cur.getDay() !== 1) cur = new Date(cur.getTime() + 86400000);
    const firstMonday = new Date(cur);
    // Top: month labels
    cur = new Date(rangeStart);
    while (cur < new Date(rangeStart.getTime() + rangeDays * 86400000)) {
      const monthEnd = new Date(cur.getFullYear(), cur.getMonth() + 1, 0);
      const startDay = Math.max(0, daysDiff(rangeStart, cur));
      const endDay = Math.min(rangeDays, daysDiff(rangeStart, monthEnd) + 1);
      const w = (endDay - startDay) * pxPerDay;
      const label = cur.toLocaleDateString('en-AU', { month: 'long', year: 'numeric' });
      topRow += `<div class="flex-shrink-0 border-r border-stone-200 text-[11px] font-semibold text-stone-500 uppercase tracking-wider px-2 flex items-center" style="width:${w}px;height:24px;">${label}</div>`;
      cur = new Date(cur.getFullYear(), cur.getMonth() + 1, 1);
    }
    // Individual days
    for (let i = 0; i < rangeDays; i++) {
      const d = new Date(rangeStart.getTime() + i * 86400000);
      const left = i * pxPerDay;
      const isWeekend = d.getDay() === 0 || d.getDay() === 6;
      const dayLabel = d.getDate();
      const borderCls = d.getDay() === 1 ? 'border-stone-300' : 'border-stone-100';
      botRow += `<div class="absolute text-[9px] text-stone-400 border-l ${borderCls} flex items-end justify-center pb-0.5" style="left:${left}px;width:${pxPerDay}px;top:0;height:100%;${isWeekend ? 'background:rgba(0,0,0,0.02);' : ''}">${pxPerDay >= 24 ? dayLabel : ''}</div>`;
    }
  }

  return { topRow, botRow, totalW };
}

// ── Grid lines (behind bars) ──────────────────────────────────────────────────

function buildGridLines(rangeStart, rangeDays, pxPerDay, totalH) {
  let lines = '';
  // Weekly vertical lines
  let d = new Date(rangeStart);
  while (d.getDay() !== 1) d = new Date(d.getTime() + 86400000);
  while (d < new Date(rangeStart.getTime() + rangeDays * 86400000)) {
    const offset = daysDiff(rangeStart, d);
    const left = offset * pxPerDay;
    lines += `<div class="absolute top-0 border-l border-stone-100" style="left:${left}px;height:${totalH}px;"></div>`;
    d = new Date(d.getTime() + 7 * 86400000);
  }
  return lines;
}

// ── Today line ────────────────────────────────────────────────────────────────

function buildTodayLine(rangeStart, pxPerDay, totalH) {
  const offset = daysDiff(rangeStart, getToday());
  const left = offset * pxPerDay;
  return `
    <div class="absolute top-0 z-30" style="left:${left}px;height:${totalH + 50}px;">
      <div class="bg-blue-500 text-white text-[9px] font-bold px-1.5 py-0.5 rounded-sm -translate-x-1/2 whitespace-nowrap">TODAY</div>
      <div class="w-px bg-blue-500 mx-auto" style="height:${totalH + 40}px;"></div>
    </div>`;
}

// ── Client rows ───────────────────────────────────────────────────────────────

function buildClientRow(c, i, rangeStart, rangeDays, pxPerDay) {
  const y = i * GANTT_ROW_H;
  const start = parseDate(c.dates?.program_start);
  const eoc = endOfCommitment(c, termToDays, bonusToDays);
  const rc = renewContact(c, termToDays, bonusToDays);
  const reviews = calculateReviews(c, termToDays, bonusToDays).filter(r => !r.completed);
  const health = normaliseHealth(c.health);
  const colors = GANTT_BAR_COLOR[health] || GANTT_DEFAULT_COLOR;

  if (!start || !eoc) {
    return `<div class="absolute flex items-center" style="left:0;top:${y}px;height:${GANTT_ROW_H}px;width:100%;">
      <div class="text-[12px] text-stone-300 pl-2">No dates</div>
    </div>`;
  }

  const startOffset = daysDiff(rangeStart, start);
  const duration = daysDiff(start, eoc);
  const barLeft = startOffset * pxPerDay;
  const barWidth = Math.max(duration * pxPerDay, 4);

  // Bar
  let html = `
    <div class="absolute flex items-center cursor-pointer group" style="left:${barLeft}px;top:${y + (GANTT_ROW_H - GANTT_BAR_H) / 2}px;width:${barWidth}px;height:${GANTT_BAR_H}px;" onclick="openEditModal(${c._idx})">
      <div class="w-full h-full rounded-full relative overflow-visible" style="background:${colors.bg};border:1.5px solid ${colors.border};">
        <span class="absolute inset-0 flex items-center px-3 text-[11px] font-semibold truncate" style="color:${colors.text};">${barWidth > 60 ? c.name : ''}</span>
      </div>
    </div>`;

  // Renewal dot
  if (rc && rc >= rangeStart) {
    const rcOffset = daysDiff(rangeStart, rc);
    const rcLeft = rcOffset * pxPerDay;
    const rcDate = fmt(rc);
    html += `
      <div class="gantt-dot absolute z-20" style="left:${rcLeft - 5}px;top:${y + GANTT_ROW_H / 2 - 5}px;">
        <div class="w-[10px] h-[10px] rounded-full bg-amber-500 border-2 border-amber-600 cursor-default"></div>
        <div class="gantt-tooltip">Renewal: ${rcDate}</div>
      </div>`;
  }

  // Review dots
  reviews.forEach(r => {
    if (r.date >= rangeStart) {
      const rOffset = daysDiff(rangeStart, r.date);
      const rLeft = rOffset * pxPerDay;
      const rDate = fmt(r.date);
      html += `
        <div class="gantt-dot absolute z-20" style="left:${rLeft - 4}px;top:${y + GANTT_ROW_H / 2 - 4}px;">
          <div class="w-[8px] h-[8px] rounded-full bg-blue-500 border-2 border-blue-700 cursor-default"></div>
          <div class="gantt-tooltip">Review ${r.reviewNum}: ${rDate}</div>
        </div>`;
    }
  });

  return html;
}

// ── Labels column ─────────────────────────────────────────────────────────────

function buildLabels(clients) {
  return clients.map((c, i) => {
    const y = i * GANTT_ROW_H;
    const health = normaliseHealth(c.health);
    const colors = GANTT_BAR_COLOR[health] || GANTT_DEFAULT_COLOR;
    return `
      <div class="absolute flex items-center px-3 border-b border-stone-100 cursor-pointer hover:bg-stone-50 transition-colors" style="top:${y}px;height:${GANTT_ROW_H}px;width:${GANTT_LABEL_W}px;" onclick="openEditModal(${c._idx})">
        <div class="w-2 h-2 rounded-full flex-shrink-0 mr-2.5" style="background:${colors.border};"></div>
        <span class="text-[12px] font-medium text-stone-700 truncate">${c.name}</span>
      </div>`;
  }).join('');
}

// ── Main render ───────────────────────────────────────────────────────────────

function renderGantt() {
  const clients = getVisible();
  const inner = document.getElementById('gantt-inner');
  if (!inner) return;

  if (clients.length === 0) {
    inner.innerHTML = '<p class="text-center text-stone-400 py-16 text-sm">No clients match this filter.</p>';
    return;
  }

  // Calculate time range
  ganttRangeStart = new Date(getToday());
  ganttRangeStart.setDate(ganttRangeStart.getDate() - 30);
  ganttRangeEnd = new Date(getToday());
  ganttRangeEnd.setDate(ganttRangeEnd.getDate() + 180);
  clients.forEach(c => {
    const eoc = endOfCommitment(c, termToDays, bonusToDays);
    if (eoc && eoc > ganttRangeEnd) ganttRangeEnd = new Date(eoc.getTime() + 14 * 86400000);
    const start = parseDate(c.dates?.program_start);
    if (start && start < ganttRangeStart) ganttRangeStart = new Date(start.getTime() - 7 * 86400000);
  });

  const rangeDays = Math.round((ganttRangeEnd - ganttRangeStart) / 86400000);
  const totalW = rangeDays * ganttZoom;
  const totalH = clients.length * GANTT_ROW_H;

  const header = buildDateHeader(ganttRangeStart, rangeDays, ganttZoom);
  const gridLines = buildGridLines(ganttRangeStart, rangeDays, ganttZoom, totalH);
  const todayLine = buildTodayLine(ganttRangeStart, ganttZoom, totalH);
  const labels = buildLabels(clients);
  const bars = clients.map((c, i) => buildClientRow(c, i, ganttRangeStart, rangeDays, ganttZoom)).join('');

  // Row backgrounds (alternating + horizontal lines)
  let rowBgs = '';
  for (let i = 0; i < clients.length; i++) {
    const y = i * GANTT_ROW_H;
    rowBgs += `<div class="absolute w-full border-b border-stone-100 ${i % 2 === 1 ? 'bg-stone-50/40' : ''}" style="top:${y}px;height:${GANTT_ROW_H}px;"></div>`;
  }

  inner.innerHTML = `
    <div class="flex" style="height:${totalH + 54}px;">
      <!-- Fixed labels -->
      <div class="flex-shrink-0 border-r border-stone-200 bg-white z-20 relative" style="width:${GANTT_LABEL_W}px;">
        <div class="h-[48px] border-b border-stone-200 flex items-end px-3 pb-1">
          <span class="text-[11px] font-semibold text-stone-400 uppercase tracking-widest">Client</span>
        </div>
        <div class="relative" style="height:${totalH}px;">
          ${labels}
        </div>
      </div>

      <!-- Scrollable timeline -->
      <div class="flex-1 overflow-x-auto overflow-y-hidden relative" id="gantt-scroll">
        <!-- Date header -->
        <div class="sticky top-0 z-10 bg-white border-b border-stone-200" style="width:${totalW}px;height:48px;">
          <div class="flex" style="height:24px;">${header.topRow}</div>
          <div class="relative" style="height:24px;">${header.botRow}</div>
        </div>

        <!-- Body -->
        <div class="relative" style="width:${totalW}px;height:${totalH}px;">
          ${rowBgs}
          ${gridLines}
          ${todayLine}
          ${bars}
        </div>
      </div>
    </div>

    <!-- Zoom controls -->
    <div class="flex items-center gap-2 mt-3 text-[12px] text-stone-400">
      <button onclick="ganttZoomOut()" class="px-2 py-1 rounded border border-stone-200 hover:bg-stone-100 text-stone-600 font-bold transition-colors">−</button>
      <button onclick="ganttZoomIn()" class="px-2 py-1 rounded border border-stone-200 hover:bg-stone-100 text-stone-600 font-bold transition-colors">+</button>
      <span class="ml-1">Zoom (or use <kbd class="px-1 py-0.5 bg-stone-100 rounded text-[10px] font-mono">+</kbd> <kbd class="px-1 py-0.5 bg-stone-100 rounded text-[10px] font-mono">−</kbd> keys)</span>
      <span class="ml-3">
        <span class="inline-block w-2 h-2 rounded-full bg-amber-500 mr-1 align-middle"></span>Renewal
        <span class="inline-block w-2 h-2 rounded-full bg-blue-500 mr-1 ml-3 align-middle"></span>Review
        <span class="inline-block w-3 h-px bg-blue-500 mr-1 ml-3 align-middle"></span>Today
      </span>
    </div>`;

  // Store scroll reference & scroll to today
  ganttScrollEl = document.getElementById('gantt-scroll');
  if (ganttScrollEl) {
    const todayOffset = daysDiff(ganttRangeStart, getToday()) * ganttZoom;
    ganttScrollEl.scrollLeft = Math.max(0, todayOffset - ganttScrollEl.clientWidth / 3);
  }
}

// ── Keyboard handler ──────────────────────────────────────────────────────────

function initGanttKeyboard() {
  document.addEventListener('keydown', (e) => {
    if (viewMode !== 'gantt') return;
    // Don't capture if user is typing in an input
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT' || e.target.tagName === 'TEXTAREA') return;

    if (e.key === '=' || e.key === '+') {
      e.preventDefault();
      ganttZoomIn();
    } else if (e.key === '-' || e.key === '_') {
      e.preventDefault();
      ganttZoomOut();
    }
  });
}

// Init keyboard on load
document.addEventListener('DOMContentLoaded', initGanttKeyboard);
