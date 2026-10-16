'use strict';

// ── gantt.js ──────────────────────────────────────────────────────────────────
// ClickUp-style Gantt chart with scrollable timeline, zoom, and hover tooltips.
// Reads from globals: allClients, termToDays, bonusToDays, schemaCache, getToday()
// Calls: getVisible(), endOfCommitment(), renewContact(), isRollingTerm(),
//        parseDate(), addDays(), daysDiff(), fmt(), openEditModal()
//
// Fixed terms draw a solid pill from program start to end of commitment.
// Month-to-month (rolling) terms draw a dashed bar that runs off the right
// edge and fades out — no end, no renewal dot. Archived rolling clients stop
// at their program end / archive date.

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
const GANTT_DEFAULT_COLOR = { bg: '#111520', border: '#4b5563', text: '#9ca3af' };

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
    let cur = new Date(rangeStart);
    while (cur < new Date(rangeStart.getTime() + rangeDays * 86400000)) {
      const monthStart = new Date(cur.getFullYear(), cur.getMonth(), 1);
      const monthEnd = new Date(cur.getFullYear(), cur.getMonth() + 1, 0);
      const startDay = Math.max(0, daysDiff(rangeStart, cur));
      const endDay = Math.min(rangeDays, daysDiff(rangeStart, monthEnd) + 1);
      const w = (endDay - startDay) * pxPerDay;
      const label = cur.toLocaleDateString('en-AU', { month: 'short', year: '2-digit' });
      topRow += `<div class="flex-shrink-0 border-r border-white/[0.06] text-[11px] font-semibold text-[#4a5568] uppercase tracking-wider px-2 flex items-center font-mono" style="width:${w}px;height:24px;">${w > 40 ? label : ''}</div>`;
      cur = new Date(cur.getFullYear(), cur.getMonth() + 1, 1);
    }
    let d = new Date(rangeStart);
    while (d.getDay() !== 1) d = new Date(d.getTime() + 86400000);
    while (d < new Date(rangeStart.getTime() + rangeDays * 86400000)) {
      const offset = daysDiff(rangeStart, d);
      const left = offset * pxPerDay;
      botRow += `<div class="absolute border-l border-white/[0.03]" style="left:${left}px;height:100%;top:0;"></div>`;
      d = new Date(d.getTime() + 7 * 86400000);
    }
  } else if (mode === 'weeks') {
    let cur = new Date(rangeStart);
    while (cur < new Date(rangeStart.getTime() + rangeDays * 86400000)) {
      const monthStart = new Date(cur.getFullYear(), cur.getMonth(), 1);
      const monthEnd = new Date(cur.getFullYear(), cur.getMonth() + 1, 0);
      const startDay = Math.max(0, daysDiff(rangeStart, cur));
      const endDay = Math.min(rangeDays, daysDiff(rangeStart, monthEnd) + 1);
      const w = (endDay - startDay) * pxPerDay;
      const label = cur.toLocaleDateString('en-AU', { month: 'short', year: '2-digit' });
      topRow += `<div class="flex-shrink-0 border-r border-white/[0.06] text-[11px] font-semibold text-[#4a5568] uppercase tracking-wider px-2 flex items-center font-mono" style="width:${w}px;height:24px;">${label}</div>`;
      cur = new Date(cur.getFullYear(), cur.getMonth() + 1, 1);
    }
    let d = new Date(rangeStart);
    while (d.getDay() !== 1) d = new Date(d.getTime() + 86400000);
    while (d < new Date(rangeStart.getTime() + rangeDays * 86400000)) {
      const offset = daysDiff(rangeStart, d);
      const left = offset * pxPerDay;
      const weekW = 7 * pxPerDay;
      const label = d.getDate();
      botRow += `<div class="absolute text-[10px] text-[#334155] border-l border-white/[0.04] px-1 font-mono" style="left:${left}px;width:${weekW}px;top:0;height:100%;">${label}</div>`;
      d = new Date(d.getTime() + 7 * 86400000);
    }
  } else {
    let cur = new Date(rangeStart);
    while (cur.getDay() !== 1) cur = new Date(cur.getTime() + 86400000);
    const firstMonday = new Date(cur);
    cur = new Date(rangeStart);
    while (cur < new Date(rangeStart.getTime() + rangeDays * 86400000)) {
      const monthEnd = new Date(cur.getFullYear(), cur.getMonth() + 1, 0);
      const startDay = Math.max(0, daysDiff(rangeStart, cur));
      const endDay = Math.min(rangeDays, daysDiff(rangeStart, monthEnd) + 1);
      const w = (endDay - startDay) * pxPerDay;
      const label = cur.toLocaleDateString('en-AU', { month: 'long', year: 'numeric' });
      topRow += `<div class="flex-shrink-0 border-r border-white/[0.06] text-[11px] font-semibold text-[#4a5568] uppercase tracking-wider px-2 flex items-center font-mono" style="width:${w}px;height:24px;">${label}</div>`;
      cur = new Date(cur.getFullYear(), cur.getMonth() + 1, 1);
    }
    for (let i = 0; i < rangeDays; i++) {
      const d = new Date(rangeStart.getTime() + i * 86400000);
      const left = i * pxPerDay;
      const isWeekend = d.getDay() === 0 || d.getDay() === 6;
      const dayLabel = d.getDate();
      const borderCls = d.getDay() === 1 ? 'border-white/[0.08]' : 'border-white/[0.03]';
      botRow += `<div class="absolute text-[9px] text-[#334155] border-l ${borderCls} flex items-end justify-center pb-0.5 font-mono" style="left:${left}px;width:${pxPerDay}px;top:0;height:100%;${isWeekend ? 'background:rgba(255,255,255,0.01);' : ''}">${pxPerDay >= 24 ? dayLabel : ''}</div>`;
    }
  }

  return { topRow, botRow, totalW };
}

// ── Grid lines (behind bars) ──────────────────────────────────────────────────

function buildGridLines(rangeStart, rangeDays, pxPerDay, totalH) {
  let lines = '';
  let d = new Date(rangeStart);
  while (d.getDay() !== 1) d = new Date(d.getTime() + 86400000);
  while (d < new Date(rangeStart.getTime() + rangeDays * 86400000)) {
    const offset = daysDiff(rangeStart, d);
    const left = offset * pxPerDay;
    lines += `<div class="absolute top-0 border-l border-white/[0.03]" style="left:${left}px;height:${totalH}px;"></div>`;
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
      <div class="bg-indigo-500 text-white text-[9px] font-bold font-mono px-1.5 py-0.5 rounded-sm -translate-x-1/2 whitespace-nowrap" style="box-shadow: 0 0 12px rgba(129,140,248,0.5), 0 2px 4px rgba(0,0,0,0.3);">TODAY</div>
      <div class="w-px bg-indigo-400/60 mx-auto" style="height:${totalH + 40}px;"></div>
    </div>`;
}

// ── Client rows ───────────────────────────────────────────────────────────────

// Month-to-month bar end: open (chart's right edge) while the client is on
// the books; archived clients stop at program end, else archive date, else today.
function rollingBarEnd(c, rangeEnd) {
  if (c.status !== 'archived') return { end: rangeEnd, open: true };
  const end = parseDate(c.archive?.program_end_date) || parseDate(c.archive?.archived_at) || getToday();
  return { end, open: false };
}

function buildClientRow(c, i, rangeStart, rangeDays, pxPerDay) {
  const y = i * GANTT_ROW_H;
  const start = parseDate(c.dates?.program_start);
  const rolling = isRollingTerm(c, termToDays);
  const { end, open } = rolling
    ? rollingBarEnd(c, addDays(rangeStart, rangeDays))
    : { end: endOfCommitment(c, termToDays, bonusToDays), open: false };
  const rc = rolling ? null : renewContact(c, termToDays, bonusToDays);
  const health = normaliseHealth(c.health);
  const colors = GANTT_BAR_COLOR[health] || GANTT_DEFAULT_COLOR;

  if (!start || !end) {
    return `<div class="absolute flex items-center" style="left:0;top:${y}px;height:${GANTT_ROW_H}px;width:100%;">
      <div class="text-[12px] text-[#334155] pl-2 font-mono">No dates</div>
    </div>`;
  }

  const startOffset = daysDiff(rangeStart, start);
  const duration = daysDiff(start, end);
  const barLeft = startOffset * pxPerDay;
  const barWidth = Math.max(duration * pxPerDay, 4);
  const barTop = y + (GANTT_ROW_H - GANTT_BAR_H) / 2;

  let html;
  if (rolling) {
    // Dashed, lighter fill; open bars lose their right cap and fade out.
    const tooltip = open ? `Month-to-month · rolling since ${fmt(start)}` : `Month-to-month · ended ${fmt(end)}`;
    const shape   = open
      ? 'border-radius:9999px 0 0 9999px;border-right:none;-webkit-mask-image:linear-gradient(90deg,#000 calc(100% - 96px),transparent);mask-image:linear-gradient(90deg,#000 calc(100% - 96px),transparent);'
      : 'border-radius:9999px;';
    html = `
      <div class="gantt-bar absolute flex items-center cursor-pointer group" style="left:${barLeft}px;top:${barTop}px;width:${barWidth}px;height:${GANTT_BAR_H}px;" onclick="openEditModal(${c._idx})">
        <div class="gantt-tooltip" style="left:${Math.min(barWidth / 2, 90)}px;">${tooltip}</div>
        <div class="w-full h-full relative" style="background:linear-gradient(180deg, ${colors.bg}aa, ${colors.bg}66);border:1.5px dashed ${colors.border};${shape}">
          <span class="absolute inset-0 flex items-center px-3 text-[11px] font-semibold truncate font-mono" style="color:${colors.text};">${barWidth > 60 ? `${c.name}<span class="ml-2 opacity-60 font-normal">↻ M2M</span>` : ''}</span>
        </div>
      </div>`;
  } else {
    // Bar with 3D depth
    html = `
      <div class="gantt-bar absolute flex items-center cursor-pointer group" style="left:${barLeft}px;top:${barTop}px;width:${barWidth}px;height:${GANTT_BAR_H}px;" onclick="openEditModal(${c._idx})">
        <div class="gantt-tooltip">Ends: ${fmt(end)}</div>
        <div class="w-full h-full rounded-full relative overflow-visible" style="background:linear-gradient(180deg, ${colors.bg}, ${colors.bg}dd);border:1.5px solid ${colors.border};box-shadow:0 0 8px ${colors.border}33, 0 2px 4px rgba(0,0,0,0.2), inset 0 1px 0 rgba(255,255,255,0.05);">
          <span class="absolute inset-0 flex items-center px-3 text-[11px] font-semibold truncate font-mono" style="color:${colors.text};">${barWidth > 60 ? c.name : ''}</span>
        </div>
      </div>`;
  }

  // Renewal dot
  if (rc && rc >= rangeStart) {
    const rcOffset = daysDiff(rangeStart, rc);
    const rcLeft = rcOffset * pxPerDay;
    const rcDate = fmt(rc);
    html += `
      <div class="gantt-dot absolute z-20" style="left:${rcLeft - 5}px;top:${y + GANTT_ROW_H / 2 - 5}px;">
        <div class="w-[10px] h-[10px] rounded-full bg-amber-400 border-2 border-amber-500 cursor-default" style="box-shadow:0 0 8px rgba(251,191,36,0.5), 0 2px 4px rgba(0,0,0,0.3);"></div>
        <div class="gantt-tooltip">Renewal: ${rcDate}</div>
      </div>`;
  }

  return html;
}

// ── Labels column ─────────────────────────────────────────────────────────────

function buildLabels(clients) {
  return clients.map((c, i) => {
    const y = i * GANTT_ROW_H;
    const health = normaliseHealth(c.health);
    const colors = GANTT_BAR_COLOR[health] || GANTT_DEFAULT_COLOR;
    return `
      <div class="absolute flex items-center px-3 border-b border-white/[0.04] cursor-pointer hover:bg-white/[0.03] transition-colors" style="top:${y}px;height:${GANTT_ROW_H}px;width:${GANTT_LABEL_W}px;" onclick="openEditModal(${c._idx})">
        <div class="w-2 h-2 rounded-full flex-shrink-0 mr-2.5" style="background:${colors.border};box-shadow:0 0 8px ${colors.border}55;"></div>
        <span class="text-[12px] font-medium text-[#e2e8f0] truncate">${c.name}</span>
      </div>`;
  }).join('');
}

// ── Main render ───────────────────────────────────────────────────────────────

function renderGantt() {
  const clients = getVisible();
  const inner = document.getElementById('gantt-inner');
  if (!inner) return;

  if (clients.length === 0) {
    inner.innerHTML = '<p class="text-center text-[#4a5568] py-16 text-sm font-mono">No clients match this filter.</p>';
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
    rowBgs += `<div class="absolute w-full border-b border-white/[0.04] ${i % 2 === 1 ? 'bg-white/[0.01]' : ''}" style="top:${y}px;height:${GANTT_ROW_H}px;"></div>`;
  }

  inner.innerHTML = `
    <div class="flex" style="height:${totalH + 54}px;">
      <!-- Fixed labels -->
      <div class="flex-shrink-0 border-r border-white/[0.06] bg-[#0a0d13] z-20 relative" style="width:${GANTT_LABEL_W}px;">
        <div class="h-[48px] border-b border-white/[0.06] flex items-end px-3 pb-1" style="background:linear-gradient(180deg, rgba(255,255,255,0.02), transparent);">
          <span class="text-[11px] font-semibold text-[#4a5568] uppercase tracking-widest font-mono">Client</span>
        </div>
        <div class="relative" style="height:${totalH}px;">
          ${labels}
        </div>
      </div>

      <!-- Scrollable timeline -->
      <div class="flex-1 overflow-x-auto overflow-y-hidden relative" id="gantt-scroll">
        <!-- Date header -->
        <div class="sticky top-0 z-10 bg-[#0a0d13] border-b border-white/[0.06]" style="width:${totalW}px;height:48px;background:linear-gradient(180deg, rgba(255,255,255,0.02), transparent);">
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

    <!-- Zoom controls with 3D buttons -->
    <div class="flex items-center gap-2 mt-3 px-4 text-[12px] text-[#4a5568] font-mono">
      <button onclick="ganttZoomOut()" class="btn-secondary px-2.5 py-1 rounded-lg text-[#8892a8] font-bold cursor-pointer">−</button>
      <button onclick="ganttZoomIn()" class="btn-secondary px-2.5 py-1 rounded-lg text-[#8892a8] font-bold cursor-pointer">+</button>
      <span class="ml-1">Zoom (or <kbd class="px-1.5 py-0.5 bg-white/[0.04] rounded text-[10px] font-mono border border-white/[0.06]" style="box-shadow:0 1px 2px rgba(0,0,0,0.2),inset 0 1px 0 rgba(255,255,255,0.05);">+</kbd> <kbd class="px-1.5 py-0.5 bg-white/[0.04] rounded text-[10px] font-mono border border-white/[0.06]" style="box-shadow:0 1px 2px rgba(0,0,0,0.2),inset 0 1px 0 rgba(255,255,255,0.05);">−</kbd> keys)</span>
      <span class="ml-3">
        <span class="inline-block w-2 h-2 rounded-full bg-amber-400 mr-1 align-middle" style="box-shadow:0 0 6px rgba(251,191,36,0.5);"></span>Renewal
        <span class="inline-block w-5 h-2.5 mr-1 ml-3 align-middle" style="border:1.5px dashed #8892a8;border-right:none;border-radius:9999px 0 0 9999px;-webkit-mask-image:linear-gradient(90deg,#000 40%,transparent);mask-image:linear-gradient(90deg,#000 40%,transparent);"></span>Month-to-month
        <span class="inline-block w-3 h-px bg-indigo-400 mr-1 ml-3 align-middle"></span>Today
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
