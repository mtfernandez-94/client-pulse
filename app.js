'use strict';

// ── State ────────────────────────────────────────────────────────────────────

let allClients   = [];
let tableColumns = [];   // from schema.json
let termToDays   = {};   // from schema.json — e.g. { '12wks': 84, '16wks': 112, ... }
let bonusToDays  = {};   // from schema.json — e.g. { '1mth': 30, '2mth': 61 }
let schemaCache  = null; // full schema object, used by addClient modal
let filterStatus = 'active';
let filterHealth = '';
let filterTerm   = '';
let sortCol = 'renewalUrgency';
let sortDir = 'asc';
let viewMode = 'table'; // 'table' | 'gantt' | 'actions'
let _lastAutoBackup = 0; // timestamp of last auto-backup
let searchQuery = '';     // current search text
let searchAllClients = false; // true = include paused/archived in search dropdown

// ── Style maps ────────────────────────────────────────────────────────────────
// Health options come from schema; styles are UI-only and keyed by schema order.
// HEALTH_ORDER, HEALTH_STYLE, and GANTT_BAR_COLOR are built in init() after
// schema loads. Declared here so they're accessible throughout the file.

const HEALTH_STYLES_BY_INDEX = [
  { badge: 'bg-blue-500/10 text-blue-400 ring-1 ring-blue-500/20',     gantt: { bg: '#0c1e3a', border: '#2563eb', text: '#60a5fa' } },
  { badge: 'bg-emerald-500/10 text-emerald-400 ring-1 ring-emerald-500/20', gantt: { bg: '#052e16', border: '#16a34a', text: '#4ade80' } },
  { badge: 'bg-amber-500/10 text-amber-400 ring-1 ring-amber-500/20',  gantt: { bg: '#2a1f04', border: '#d97706', text: '#fbbf24' } },
  { badge: 'bg-rose-500/10 text-rose-400 ring-1 ring-rose-500/20',     gantt: { bg: '#2a0a0a', border: '#dc2626', text: '#f87171' } },
  { badge: 'bg-white/[0.05] text-[#8892a8] ring-1 ring-white/[0.08]', gantt: { bg: '#111520', border: '#4b5563', text: '#9ca3af' } },
];

let HEALTH_ORDER = {};
let HEALTH_STYLE = {};
const STATUS_STYLE = {
  active:   'bg-emerald-500/10 text-emerald-400 ring-1 ring-emerald-500/20',
  paused:   'bg-amber-500/10 text-amber-400 ring-1 ring-amber-500/20',
  archived: 'bg-white/[0.05] text-[#64748b] ring-1 ring-white/[0.06]',
};

// ── Calculated field dispatch ─────────────────────────────────────────────────
// Dispatch map built once at module scope (closures capture the let globals).
const CALC_FNS = {
  'calc.end_of_commitment': c => endOfCommitment(c, termToDays, bonusToDays),
  'calc.renew_contact':     c => renewContact(c, termToDays, bonusToDays),
  'calc.next_review':       c => nextReview(c, termToDays, bonusToDays),
};
function getCalc(key) { return CALC_FNS[key] || null; }

// ── Filter & sort ─────────────────────────────────────────────────────────────

const PAYMENT_PERIOD_ORDER = { 'PIF': 0, 'Weekly': 1, 'Biweekly': 2, 'Monthly': 3, 'Split PIF (2)': 4 };

function getVisible() {
  let list = allClients.map((c, i) => ({ ...c, _health: normaliseHealth(c.health), _idx: i }));

  if (filterStatus !== 'all') list = list.filter(c => c.status === filterStatus);
  if (filterHealth)            list = list.filter(c => c._health === filterHealth);
  if (filterTerm)              list = list.filter(c => c.contract?.term === filterTerm);
  if (searchQuery) {
    const q = searchQuery.toLowerCase();
    list = list.filter(c => c.name.toLowerCase().includes(q));
  }

  // Pre-compute expensive date fields once per client (instead of O(n log n) times during sort)
  list.forEach(c => {
    c._endDate       = endOfCommitment(c, termToDays, bonusToDays)?.getTime() ?? 9e15;
    c._urgency       = urgencyScore(c, termToDays, bonusToDays);
    c._nextReview    = nextReview(c, termToDays, bonusToDays)?.getTime() ?? 9e15;
    c._programStart  = parseDate(c.dates?.program_start)?.getTime() ?? 0;
  });

  list.sort((a, b) => {
    let diff = 0;
    switch (sortCol) {
      case 'name':
        diff = a.name.localeCompare(b.name); break;
      case 'health':
        diff = (HEALTH_ORDER[a._health] ?? 99) - (HEALTH_ORDER[b._health] ?? 99); break;
      case 'status':
        diff = (a.status || '').localeCompare(b.status || ''); break;
      case 'term':
        diff = (a.contract?.term || '').localeCompare(b.contract?.term || ''); break;
      case 'paymentAmount': {
        const ca = getPath(a, 'payment.currency') || '', cb = getPath(b, 'payment.currency') || '';
        diff = ca.localeCompare(cb);
        if (diff === 0) diff = (getPath(a, 'payment.amount') || 0) - (getPath(b, 'payment.amount') || 0);
        break;
      }
      case 'processor':
        diff = (getPath(a, 'payment.processor') || '').localeCompare(getPath(b, 'payment.processor') || ''); break;
      case 'paymentPeriod': {
        const pa = getPath(a, 'payment.period') || '', pb = getPath(b, 'payment.period') || '';
        diff = (PAYMENT_PERIOD_ORDER[pa] ?? 99) - (PAYMENT_PERIOD_ORDER[pb] ?? 99);
        if (diff === 0) diff = pa.localeCompare(pb);
        break;
      }
      case 'programStart':
        diff = a._programStart - b._programStart; break;
      case 'endDate':
        diff = a._endDate - b._endDate; break;
      case 'renewalUrgency':
        diff = a._urgency - b._urgency; break;
      case 'nextReview':
        diff = a._nextReview - b._nextReview; break;
    }
    return sortDir === 'asc' ? diff : -diff;
  });

  return list;
}

// ── Resolve dot-notation path: "contract.term" → client.contract.term ─────────

function getPath(obj, path) {
  return path.split('.').reduce((o, k) => o?.[k], obj);
}

// ── Rendering helpers ─────────────────────────────────────────────────────────

function healthBadge(h) {
  if (!h) return '<span class="text-[#4a5568]">—</span>';
  const cls = HEALTH_STYLE[h] || 'bg-white/[0.05] text-[#64748b]';
  return `<span class="inline-flex items-center px-2 py-0.5 rounded-md text-[11px] font-medium ${cls}">${h}</span>`;
}

function statusBadge(s) {
  const cls = STATUS_STYLE[s] || 'bg-white/[0.05] text-[#64748b]';
  return `<span class="inline-flex items-center px-2 py-0.5 rounded-md text-[11px] font-medium capitalize ${cls}">${s}</span>`;
}

function flagBadge(type) {
  if (!type) return '';
  if (type === 'overdue') return ' <span class="text-[11px] font-semibold text-rose-400 ml-1.5">Overdue</span>';
  return ' <span class="text-[11px] font-semibold text-amber-400 ml-1.5">This week</span>';
}

function paymentCell(c) {
  const p = c.payment;
  if (!p) return '<span class="text-[#4a5568]">—</span>';
  const cur = p.currency;
  const amt = p.amount;
  if (!cur || typeof cur !== 'string' || cur.length > 4) return '<span class="text-[#4a5568]">—</span>';
  if (amt === 'paid') return `<span class="text-[#8892a8]">${cur} PIF <span class="text-emerald-400">✓</span></span>`;
  if (typeof amt !== 'number') return '<span class="text-[#4a5568]">—</span>';
  const gst = p.gst ? '<span class="text-[#4a5568] ml-0.5">+GST</span>' : '';
  return `<span class="tabular-nums font-mono">${cur} ${amt.toLocaleString('en-AU')}</span>${gst}`;
}

// ── Cell renderer ─────────────────────────────────────────────────────────────

const TD = 'px-5 py-3.5 whitespace-nowrap';
const TD_MUTED = `${TD} text-[#64748b] font-mono text-[12px]`;

function renderCell(client, col) {
  const idx = client._idx;

  switch (col.cell_type) {
    case 'name':
      return `<td class="${TD} font-medium text-white">
        <span class="cursor-pointer hover:text-indigo-400 transition-colors" onclick="openEditModal(${idx})">${client.name}</span>
      </td>`;

    case 'health_badge': {
      const options = schemaCache?.fields?.health?.options || [];
      const opts = options.map(o => `<option value="${o}" ${o === client._health ? 'selected' : ''}>${o}</option>`).join('');
      return `<td class="${TD}">
        <select onchange="updateHealth(${idx}, this.value)" class="appearance-none bg-transparent border-0 cursor-pointer text-[11px] font-medium focus:ring-0 p-0 text-[#e2e8f0]">
          ${opts}
        </select>
      </td>`;
    }

    case 'status_badge':
      return `<td class="${TD}">${statusBadge(client.status)}</td>`;

    case 'text': {
      const val = getPath(client, col.key);
      return `<td class="${TD_MUTED}">${val || '—'}</td>`;
    }

    case 'payment':
      return `<td class="${TD}">${paymentCell(client)}</td>`;

    case 'date': {
      const val = getPath(client, col.key);
      // Only program_start is inline-editable in the table
      if (col.key === 'dates.program_start') {
        return `<td class="${TD_MUTED} inline-date-cell" data-inline-date="${col.key}" data-idx="${idx}" data-val="${val || ''}">
          ${fmt(parseDate(val))}<span class="edit-hint">✎</span>
        </td>`;
      }
      return `<td class="${TD_MUTED}">${fmt(parseDate(val))}</td>`;
    }

    case 'calc_date': {
      const fn = getCalc(col.key);
      return `<td class="${TD_MUTED}">${fmt(fn?.(client))}</td>`;
    }

    case 'renewal_flag': {
      const rc = renewContact(client, termToDays, bonusToDays);
      const rf = renewalFlag(client, termToDays, bonusToDays);
      const cls = rf ? 'font-medium text-white font-mono text-[12px]' : 'text-[#64748b] font-mono text-[12px]';
      const clickable = rf && client.renewal?.status === 'pending' ? ` onclick="openRenewalModal(${idx})" class="cursor-pointer hover:bg-white/[0.04] rounded-md transition-colors"` : '';
      return `<td class="${TD}"${clickable}><span class="${cls}">${fmt(rc)}</span>${flagBadge(rf)}</td>`;
    }

    case 'review_flag': {
      const nri = nextReviewInfo(client, termToDays, bonusToDays);
      if (!nri) {
        const reason = diagnoseMissingReviews(client, termToDays, bonusToDays);
        if (reason) return `<td class="${TD_MUTED}"><span class="text-amber-400/70 text-[11px]" title="${reason}">⚠ Missing data</span></td>`;
        return `<td class="${TD_MUTED}"><span class="text-[#4a5568]">—</span></td>`;
      }
      const nr  = nri.date;
      const rvf = reviewFlag(client, termToDays, bonusToDays);
      const cls = rvf ? 'font-medium text-white font-mono text-[12px]' : 'text-[#64748b] font-mono text-[12px]';
      const clickable = nri && rvf ? ` onclick="openReviewModal(${idx}, ${nri.reviewNum})" class="cursor-pointer hover:bg-white/[0.04] rounded-md transition-colors"` : '';
      return `<td class="${TD}"${clickable}><span class="${cls}">${fmt(nr)}</span>${flagBadge(rvf)}</td>`;
    }

    default:
      return `<td class="${TD_MUTED}">—</td>`;
  }
}

// ── Sort icons ────────────────────────────────────────────────────────────────

function updateSortIcons() {
  document.querySelectorAll('.sort-header').forEach(th => {
    const icon = th.querySelector('.sort-icon');
    if (!icon) return;
    if (th.dataset.sort === sortCol) {
      icon.textContent = sortDir === 'asc' ? '↑' : '↓';
      icon.className   = 'sort-icon text-indigo-400 ml-0.5';
    } else {
      icon.textContent = '↕';
      icon.className   = 'sort-icon text-[#2d3748] ml-0.5';
    }
  });
}

// ── Search ─────────────────────────────────────────────────────────────────────

function toggleSearch() {
  const expand = document.getElementById('search-expand');
  if (!expand) return;
  const isHidden = expand.classList.contains('hidden');
  if (isHidden) {
    openSearch();
  } else {
    closeSearch();
  }
}

function openSearch() {
  const expand = document.getElementById('search-expand');
  if (!expand) return;
  expand.classList.remove('hidden');
  setTimeout(() => document.getElementById('search-input')?.focus(), 50);
}

function closeSearch() {
  document.getElementById('search-expand')?.classList.add('hidden');
  document.getElementById('search-dropdown')?.classList.add('hidden');
  const input = document.getElementById('search-input');
  if (input) input.value = '';
  // Reset search-all toggle (text + indigo highlight class)
  if (searchAllClients) {
    searchAllClients = false;
    const btn = document.getElementById('btn-search-all');
    if (btn) {
      btn.textContent = 'Active only';
      btn.classList.remove('text-indigo-400');
      btn.classList.add('text-[#4a5568]');
    }
  }
  if (searchQuery) {
    searchQuery = '';
    render();
  }
}

function onSearchInput(value) {
  searchQuery = value.trim();
  render();
  if (!searchQuery) {
    document.getElementById('search-dropdown')?.classList.add('hidden');
    return;
  }
  renderSearchDropdown(searchQuery);
}

function toggleSearchAll() {
  searchAllClients = !searchAllClients;
  const btn = document.getElementById('btn-search-all');
  if (btn) {
    btn.textContent = searchAllClients ? 'All clients' : 'Active only';
    btn.classList.toggle('text-indigo-400', searchAllClients);
    btn.classList.toggle('text-[#4a5568]', !searchAllClients);
  }
  const currentQuery = document.getElementById('search-input')?.value?.trim() || '';
  if (currentQuery) renderSearchDropdown(currentQuery);
}

function renderSearchDropdown(query) {
  const dropdown = document.getElementById('search-dropdown');
  if (!dropdown) return;
  const q = query.toLowerCase();
  const pool = allClients
    .map((c, i) => ({ ...c, _idx: i }))
    .filter(c => searchAllClients ? true : c.status === 'active')
    .filter(c => c.name.toLowerCase().includes(q));

  if (pool.length === 0) {
    dropdown.innerHTML = '<div class="px-4 py-3 text-[13px] text-[#4a5568] font-mono">No matches</div>';
    dropdown.classList.remove('hidden');
    return;
  }

  dropdown.innerHTML = pool.slice(0, 12).map(c => {
    // Bold-highlight matching substring
    const lower = c.name.toLowerCase();
    const start = lower.indexOf(q);
    const end   = start + q.length;
    const highlighted = start >= 0
      ? c.name.slice(0, start) + `<span class="text-indigo-400 font-semibold">${c.name.slice(start, end)}</span>` + c.name.slice(end)
      : c.name;
    const statusDot = c.status === 'paused' ? ' <span class="text-amber-400/60 text-[10px]">⏸</span>' : c.status === 'archived' ? ' <span class="text-[#4a5568] text-[10px]">archived</span>' : '';
    return `<div class="px-4 py-2.5 text-[13px] text-[#e2e8f0] hover:bg-white/[0.05] cursor-pointer transition-colors flex items-center gap-2"
      onclick="openEditModal(${c._idx}); closeSearch();">
      ${highlighted}${statusDot}
    </div>`;
  }).join('');
  dropdown.classList.remove('hidden');
}

// ── Filter button state ───────────────────────────────────────────────────────

function updateFilterButtons() {
  ['active', 'paused', 'archived', 'all'].forEach(s => {
    const btn = document.getElementById(`filter-${s}`);
    if (!btn) return;
    if (s === filterStatus) {
      btn.classList.add('active');
      btn.classList.remove('text-[#64748b]');
    } else {
      btn.classList.remove('active');
      btn.classList.add('text-[#64748b]');
    }
  });
}

// ── Header render ─────────────────────────────────────────────────────────────

function renderHeaders() {
  const thead = document.getElementById('thead');
  thead.innerHTML = '<tr class="border-b border-white/[0.06] text-[11px] font-semibold text-[#4a5568] uppercase tracking-widest font-mono">' +
    tableColumns.map(col => {
      if (!col.sortable) {
        return `<th class="px-5 py-3 text-left whitespace-nowrap font-semibold">${col.label}</th>`;
      }
      const icon = col.sort_key === sortCol
        ? `<span class="sort-icon text-indigo-400 ml-0.5">${sortDir === 'asc' ? '↑' : '↓'}</span>`
        : `<span class="sort-icon text-[#2d3748] ml-0.5">↕</span>`;
      return `<th class="sort-header px-5 py-3 text-left cursor-pointer select-none whitespace-nowrap font-semibold hover:text-[#8892a8] transition-colors" data-sort="${col.sort_key}">
        ${col.label}${icon}
      </th>`;
    }).join('') +
    '</tr>';

  document.querySelectorAll('.sort-header').forEach(th => {
    th.addEventListener('click', () => {
      const col = th.dataset.sort;
      sortDir = sortCol === col ? (sortDir === 'asc' ? 'desc' : 'asc') : 'asc';
      sortCol = col;
      render();
    });
  });
}

// ── Main render ───────────────────────────────────────────────────────────────

function render() {
  checkScheduledPauses();
  updateFilterButtons();
  updateSortIcons();
  updateViewToggle();

  const clients = getVisible();
  document.getElementById('row-count').textContent = `${clients.length} client${clients.length !== 1 ? 's' : ''}`;

  if (viewMode === 'gantt') {
    document.getElementById('table-wrap').classList.add('hidden');
    document.getElementById('gantt-wrap').classList.remove('hidden');
    document.getElementById('actions-wrap').classList.add('hidden');
    document.getElementById('btn-bulk-notes')?.classList.remove('hidden');
    renderGantt();
    return;
  }

  if (viewMode === 'actions') {
    document.getElementById('table-wrap').classList.add('hidden');
    document.getElementById('gantt-wrap').classList.add('hidden');
    document.getElementById('actions-wrap').classList.remove('hidden');
    document.getElementById('btn-bulk-notes')?.classList.remove('hidden');
    renderActionItems();
    return;
  }

  document.getElementById('table-wrap').classList.remove('hidden');
  document.getElementById('gantt-wrap').classList.add('hidden');
  document.getElementById('actions-wrap').classList.add('hidden');
  document.getElementById('btn-bulk-notes')?.classList.remove('hidden');
  const colspan = tableColumns.length;
  const tbody = document.getElementById('tbody');

  if (clients.length === 0) {
    tbody.innerHTML = `<tr><td colspan="${colspan}" class="text-center text-[#4a5568] py-12 font-mono">No clients match this filter.</td></tr>`;
    return;
  }

  tbody.innerHTML = clients.map(c => {
    const hColors = GANTT_BAR_COLOR[c._health] || GANTT_DEFAULT_COLOR;
    return `<tr class="border-b border-white/[0.04] transition-all" style="box-shadow:inset 3px 0 0 ${hColors.border};">
      ${tableColumns.map(col => renderCell(c, col)).join('')}
    </tr>`;
  }).join('');
}

// ── Gantt view ───────────────────────────────────────────────────────────────
// Moved to gantt.js (ClickUp-style with scroll, zoom, and hover tooltips)

// ── Stats bar — 3D KPI cards + health distribution bar ────────────────────────

function kpiCard(value, label, color, bgColor) {
  return `<div class="kpi-card" style="--kpi-color:${color};--kpi-bg:${bgColor};">
    <div class="kpi-value font-mono">${value}</div>
    <div class="kpi-label">${label}</div>
  </div>`;
}

function renderStats() {
  const total = allClients.length;
  const activeClients = allClients.filter(c => c.status === 'active');
  const active = activeClients.length;
  const paused = allClients.filter(c => c.status === 'paused').length;
  const archived = allClients.filter(c => c.status === 'archived').length;

  // Urgency counts
  const renewalsDue = activeClients.filter(c => renewalFlag(c, termToDays, bonusToDays)).length;
  const reviewsDue = activeClients.filter(c => reviewFlag(c, termToDays, bonusToDays)).length;

  // Health distribution bar
  const healthOptions = schemaCache?.fields?.health?.options || [];
  const healthCounts = {};
  activeClients.forEach(c => {
    const h = normaliseHealth(c.health);
    healthCounts[h] = (healthCounts[h] || 0) + 1;
  });
  const barSegments = healthOptions.map(h => {
    const count = healthCounts[h] || 0;
    const pct = active > 0 ? (count / active) * 100 : 0;
    const colors = GANTT_BAR_COLOR[h] || GANTT_DEFAULT_COLOR;
    if (pct <= 0) return '';
    return `<div class="health-bar-segment rounded-sm" style="width:${pct}%;background:${colors.border};box-shadow:0 0 8px ${colors.border}40;" title="${h}: ${count}"></div>`;
  }).join('');

  document.getElementById('stats').innerHTML = `
    <div class="grid grid-cols-3 sm:grid-cols-6 gap-3 mb-4">
      ${kpiCard(total, 'Total Clients', '#818cf8', 'rgba(129,140,248,0.15)')}
      ${kpiCard(active, 'Active', '#34d399', 'rgba(52,211,153,0.15)')}
      ${kpiCard(paused, 'Paused', '#fbbf24', 'rgba(251,191,36,0.15)')}
      ${kpiCard(archived, 'Archived', '#64748b', 'rgba(100,116,139,0.1)')}
      ${kpiCard(renewalsDue, 'Renewals Due', renewalsDue > 0 ? '#f87171' : '#64748b', renewalsDue > 0 ? 'rgba(248,113,113,0.15)' : 'rgba(100,116,139,0.1)')}
      ${kpiCard(reviewsDue, 'Reviews Due', reviewsDue > 0 ? '#fbbf24' : '#64748b', reviewsDue > 0 ? 'rgba(251,191,36,0.15)' : 'rgba(100,116,139,0.1)')}
    </div>
    ${active > 0 ? `<div class="flex h-1.5 rounded-full overflow-hidden gap-0.5">${barSegments}</div>` : ''}
  `;

  document.getElementById('today-display').textContent =
    getToday().toLocaleDateString('en-AU', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
}

// ── CSV export ─────────────────────────────────────────────────────────────

function exportCSV() {
  const clients = getVisible();
  if (clients.length === 0) return;

  // Build header row from schema table_columns
  const headers = tableColumns.map(col => col.label);

  // Build data rows — resolve each cell to a plain text value
  const rows = clients.map(c => {
    return tableColumns.map(col => {
      switch (col.cell_type) {
        case 'name':
          return c.name || '';
        case 'health_badge':
          return normaliseHealth(c.health) || '';
        case 'status_badge':
          return c.status || '';
        case 'payment': {
          const p = c.payment;
          if (!p) return '';
          if (p.amount === 'paid') return `${p.currency || ''} PIF`;
          return `${p.currency || ''} ${p.amount ?? ''}${p.gst ? ' +GST' : ''}`;
        }
        case 'calc_date': {
          const fn = getCalc(col.key);
          return fn ? fmt(fn(c)) : '';
        }
        case 'renewal_flag': {
          const rc = renewContact(c, termToDays, bonusToDays);
          const rf = renewalFlag(c, termToDays, bonusToDays);
          let val = fmt(rc);
          if (rf === 'overdue') val += ' (Overdue)';
          else if (rf === 'soon') val += ' (This week)';
          return val;
        }
        case 'review_flag': {
          const nr = nextReview(c, termToDays, bonusToDays);
          const rvf = reviewFlag(c, termToDays, bonusToDays);
          let val = fmt(nr);
          if (rvf === 'overdue') val += ' (Overdue)';
          else if (rvf === 'soon') val += ' (This week)';
          return val;
        }
        case 'date': {
          const raw = getPath(c, col.key);
          return raw || '';
        }
        default: {
          const raw = getPath(c, col.key);
          return raw != null ? String(raw) : '';
        }
      }
    });
  });

  // Escape CSV values (handle commas, quotes, newlines)
  const escape = v => {
    const s = String(v ?? '');
    if (s.includes(',') || s.includes('"') || s.includes('\n')) {
      return `"${s.replace(/"/g, '""')}"`;
    }
    return s;
  };

  const csv = [headers.map(escape).join(',')]
    .concat(rows.map(r => r.map(escape).join(',')))
    .join('\n');

  // Download
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `client-pulse-${todayISO()}.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// ── JSON Backup Export ────────────────────────────────────────────────────────

function exportBackupJSON() {
  if (allClients.length === 0) { alert('No clients to export.'); return; }
  const backup = {
    schema_version: '1.0',
    exported: new Date().toISOString(),
    clients: allClients.map(c => {
      const copy = { ...c };
      delete copy.id; // strip Supabase row IDs — re-generated on import
      return copy;
    }),
  };
  const json = JSON.stringify(backup, null, 2);
  const blob = new Blob([json], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `client-pulse-backup-${todayISO()}.json`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function importBackupJSON() {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.json';
  input.onchange = async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      const text = await file.text();
      const data = JSON.parse(text);
      const clients = data.clients;
      if (!Array.isArray(clients) || clients.length === 0) {
        alert('No clients found in backup file.'); return;
      }
      if (!confirm(`Import ${clients.length} clients from backup? This will add them to your account.`)) return;
      const session = await sbGetSession();
      if (!session) { alert('Not signed in.'); return; }
      const imported = await sbSeedClients(clients, session.user.id);
      allClients = allClients.concat(imported);
      render();
      renderStats();
      alert(`Successfully imported ${imported.length} clients.`);
    } catch (err) {
      console.error('Import failed:', err);
      alert('Import failed: ' + (err.message || JSON.stringify(err)));
    }
  };
  input.click();
}

// ── Events ────────────────────────────────────────────────────────────────────

function setupEvents() {
  ['active', 'paused', 'archived', 'all'].forEach(s => {
    document.getElementById(`filter-${s}`)?.addEventListener('click', () => {
      filterStatus = s;
      render();
    });
  });

  document.getElementById('filter-health')?.addEventListener('change', e => {
    filterHealth = e.target.value;
    render();
  });
  document.getElementById('filter-term')?.addEventListener('change', e => {
    filterTerm = e.target.value;
    render();
  });
  document.getElementById('view-table')?.addEventListener('click', () => { viewMode = 'table'; render(); });
  document.getElementById('view-gantt')?.addEventListener('click', () => { viewMode = 'gantt'; render(); });
  document.getElementById('view-actions')?.addEventListener('click', () => { viewMode = 'actions'; render(); });
  document.getElementById('btn-export-csv')?.addEventListener('click', () => { exportCSV(); closeHamburger(); });
  document.getElementById('btn-import-json')?.addEventListener('click', () => { importBackupJSON(); closeHamburger(); });
  document.getElementById('btn-bulk-notes')?.addEventListener('click', openBulkNotesModal);

  // ── Hamburger menu ────────────────────────────────────────────────────────
  document.getElementById('btn-hamburger')?.addEventListener('click', e => {
    e.stopPropagation();
    toggleHamburger();
  });

  // ── Search ────────────────────────────────────────────────────────────────
  document.getElementById('btn-search')?.addEventListener('click', e => {
    e.stopPropagation();
    toggleSearch();
  });
  document.getElementById('btn-search-all')?.addEventListener('click', e => {
    e.stopPropagation();
    toggleSearchAll();
  });
  document.getElementById('search-input')?.addEventListener('input', e => {
    onSearchInput(e.target.value);
  });
  document.getElementById('search-input')?.addEventListener('keydown', e => {
    if (e.key === 'Escape') closeSearch();
  });

  // ── Global hotkeys ────────────────────────────────────────────────────────
  document.addEventListener('keydown', handleGlobalHotkey);

  // ── Click-outside: close hamburger and search ─────────────────────────────
  document.addEventListener('click', e => {
    if (!document.getElementById('hamburger-wrap')?.contains(e.target)) closeHamburger();
    if (!document.getElementById('search-wrapper')?.contains(e.target)) closeSearch();
  });

  // ── Inline date editing: event delegation on tbody ───────────────────────
  document.getElementById('tbody')?.addEventListener('click', e => {
    const td = e.target.closest('[data-inline-date]');
    if (!td) return;
    openInlineDatePicker(td);
  });
}

// ── Hamburger menu ─────────────────────────────────────────────────────────────

function toggleHamburger() {
  const menu = document.getElementById('hamburger-menu');
  if (!menu) return;
  menu.classList.toggle('hidden');
}

function closeHamburger() {
  document.getElementById('hamburger-menu')?.classList.add('hidden');
}

// ── Global hotkeys ─────────────────────────────────────────────────────────────

function handleGlobalHotkey(e) {
  // Skip if typing in any interactive element
  const tag = (e.target.tagName || '').toLowerCase();
  if (['input', 'textarea', 'select'].includes(tag) || e.target.isContentEditable) return;

  // Skip if a modal is open
  const modal = document.getElementById('add-client-modal');
  if (modal && !modal.classList.contains('hidden') && modal.innerHTML.trim() !== '') return;

  // Skip if modifier keys are held (avoid clashing with browser shortcuts)
  if (e.metaKey || e.ctrlKey || e.altKey) return;

  switch (e.key.toLowerCase()) {
    case 'j':
      e.preventDefault();
      toggleSearch();
      break;
    case 'b':
      e.preventDefault();
      openBulkNotesModal();
      break;
    case 't':
      e.preventDefault();
      viewMode = 'table';
      render();
      break;
    case 'g':
      e.preventDefault();
      viewMode = 'gantt';
      render();
      break;
    case 'a':
      e.preventDefault();
      viewMode = 'actions';
      render();
      break;
  }
}

function updateViewToggle() {
  const viewMap = { 'view-table': 'table', 'view-gantt': 'gantt', 'view-actions': 'actions' };
  Object.entries(viewMap).forEach(([id, mode]) => {
    const btn = document.getElementById(id);
    if (!btn) return;
    if (viewMode === mode) {
      btn.classList.add('active');
      btn.classList.remove('text-[#64748b]');
    } else {
      btn.classList.remove('active');
      btn.classList.add('text-[#64748b]');
    }
  });
}

// ── Inline editing ────────────────────────────────────────────────────────────

// Save a single client (by idx) to Supabase, or all clients if no idx given.
// Debounced to avoid hammering the API on rapid changes.
let _saveQueue = new Set();
let _saveTimer = null;

function saveClients(idx) {
  if (typeof idx === 'number') _saveQueue.add(idx);
  clearTimeout(_saveTimer);
  _saveTimer = setTimeout(_flushSave, 300);
}

async function _flushSave() {
  const indices = [..._saveQueue];
  _saveQueue.clear();
  try {
    const session = await sbGetSession();
    if (!session) return;
    const coachId = session.user.id;
    for (const i of indices) {
      const client = allClients[i];
      if (client && client.id) await sbSaveClient(client, coachId);
    }
    // Dispatch event so other systems (auto-backup, toasts) can hook in
    window.dispatchEvent(new CustomEvent('clientSaved', { detail: { indices } }));
    // Auto-backup: throttled to at most once per 5 minutes
    const now = Date.now();
    if (now - _lastAutoBackup > 5 * 60 * 1000) {
      _lastAutoBackup = now;
      autoBackup();
    }
  } catch (e) {
    console.error('Could not save to Supabase:', e);
    showToast('Could not save. Check connection.', 'error');
  }
}

function updateHealth(idx, value) {
  const c = allClients[idx];
  const wasAttention = normaliseHealth(c.health) === '🚩 Attention';
  const isAttention  = normaliseHealth(value) === '🚩 Attention';
  if (isAttention && !wasAttention) {
    // Show in-app modal to capture flag reason before saving
    openFlagReasonModal(idx, value);
    return;
  }
  if (!isAttention) c.flag_reason = '';
  c.health = value;
  saveClients(idx);
  render();
}

function openFlagReasonModal(idx, healthValue) {
  const client = allClients[idx];
  const modal  = document.getElementById('add-client-modal');
  modal.classList.remove('hidden');
  const inputCls = 'input-dark w-full bg-[#0a0d13] border border-white/[0.08] rounded-lg px-3 py-2.5 text-[13px] text-[#e2e8f0] focus:outline-none transition-all placeholder-[#4a5568]';
  modal.innerHTML = `
    <div class="fixed inset-0 bg-black/60 backdrop-blur-sm z-40" onclick="cancelFlagReason(${idx})"></div>
    <div class="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div class="modal-panel rounded-2xl w-full max-w-sm border border-white/[0.06]">
        <div class="px-6 pt-6 pb-4 flex items-center justify-between">
          <h2 class="text-base font-semibold text-white">Flag: ${client.name}</h2>
          <button type="button" onclick="cancelFlagReason(${idx})" class="text-[#4a5568] hover:text-[#8892a8] text-lg leading-none transition-colors">&times;</button>
        </div>
        <div class="px-6 py-4">
          <label class="block text-[12px] font-medium text-[#64748b] mb-2">Why is this client flagged? <span class="text-[#4a5568] font-normal">(optional)</span></label>
          <input type="text" id="flag-reason-input" class="${inputCls}" placeholder="e.g. Missed check-ins, form breaking down" autofocus>
        </div>
        <div class="px-6 py-4 border-t border-white/[0.06] flex justify-end gap-2">
          <button type="button" onclick="cancelFlagReason(${idx})" class="px-3.5 py-2 text-[13px] font-medium text-[#64748b] hover:text-[#e2e8f0] transition-colors">Cancel</button>
          <button type="button" onclick="submitFlagReason(${idx}, '${healthValue.replace(/'/g, "\\'")}')" class="px-5 py-2 btn-primary text-[13px] font-semibold text-white rounded-lg">Flag Client</button>
        </div>
      </div>
    </div>`;
  // Allow Enter key to submit
  setTimeout(() => {
    const inp = document.getElementById('flag-reason-input');
    if (inp) inp.addEventListener('keydown', e => { if (e.key === 'Enter') submitFlagReason(idx, healthValue); });
  }, 50);
}

function submitFlagReason(idx, healthValue) {
  const c = allClients[idx];
  c.flag_reason = document.getElementById('flag-reason-input')?.value?.trim() || '';
  c.health = healthValue;
  saveClients(idx);
  closeModal();
  render();
}

function cancelFlagReason(idx) {
  // Health dropdown reverted by re-render — no state change needed
  closeModal();
  render();
}

function markReviewComplete(idx, reviewNum) {
  const c = allClients[idx];
  if (!c) return;
  const key = `review_${reviewNum}`;
  c.reviews = c.reviews || {};
  c.reviews[key] = { ...c.reviews[key], completed: true, completed_date: todayISO() };
  saveClients(idx);
  openEditModal(idx);
  render();
}

// ── Review completion modal ──────────────────────────────────────────────────

function openReviewModal(idx, reviewNum) {
  const client = allClients[idx];
  if (!client) return;
  const reviews = calculateReviews(client, termToDays, bonusToDays);
  const review = reviews.find(r => r.reviewNum === reviewNum);
  if (!review || review.completed) return;

  const modal = document.getElementById('add-client-modal');
  if (!modal) return;
  const inputCls = 'input-dark w-full bg-[#0a0d13] border border-white/[0.08] rounded-lg px-3 py-2.5 text-[13px] text-[#e2e8f0] focus:outline-none transition-all placeholder-[#4a5568]';
  const reviewDate = fmt(review.date);
  const overdue = review.date < getToday();

  modal.classList.remove('hidden');
  modal.innerHTML = `
    <div class="fixed inset-0 bg-black/60 backdrop-blur-sm z-40" onclick="closeModal()"></div>
    <div class="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div class="modal-panel rounded-2xl w-full max-w-lg border border-white/[0.06]">
        <div class="px-6 pt-6 pb-4 flex items-center justify-between">
          <h2 class="text-base font-semibold text-white">Review ${reviewNum}: ${client.name}</h2>
          <button type="button" onclick="closeModal()" class="text-[#4a5568] hover:text-[#8892a8] text-lg leading-none transition-colors">&times;</button>
        </div>
        <div class="px-6 py-5 space-y-4">
          <div class="flex items-center gap-3 text-[13px]">
            <span class="text-[#64748b]">Due date:</span>
            <span class="${overdue ? 'font-semibold text-rose-400' : 'text-white'} font-mono">${reviewDate}${overdue ? ' (overdue)' : ''}</span>
          </div>
          <div>
            <label class="block text-[12px] font-medium text-[#64748b] mb-1">Notes (optional)</label>
            <textarea id="review-notes" class="${inputCls}" rows="3" placeholder="e.g. Progressing well, increase difficulty next block"></textarea>
          </div>
        </div>
        <div class="px-6 py-4 border-t border-white/[0.06] flex justify-end gap-2">
          <button type="button" onclick="closeModal()" class="px-3.5 py-2 text-[13px] font-medium text-[#64748b] hover:text-[#e2e8f0] transition-colors">Cancel</button>
          <button type="button" onclick="submitReview(${idx}, ${reviewNum})" class="px-5 py-2 btn-primary text-[13px] font-semibold text-white rounded-lg">Mark complete</button>
        </div>
      </div>
    </div>`;
}

function submitReview(idx, reviewNum) {
  const client = allClients[idx];
  if (!client) return;
  const notes = document.getElementById('review-notes')?.value?.trim() || null;
  const key   = `review_${reviewNum}`;
  client.reviews = client.reviews || {};
  client.reviews[key] = { ...client.reviews[key], completed: true, completed_date: todayISO(), notes };

  // Also save review notes to client_notes
  if (notes) {
    if (!client.client_notes) client.client_notes = [];
    client.client_notes.push({
      id:   crypto.randomUUID(),
      date: new Date().toISOString(),
      note: `**Review ${reviewNum} completed**\n${notes}`,
    });
  }

  saveClients(idx);
  closeModal();
  render();
  renderStats();
  showToast(`Review ${reviewNum} marked complete`);
}

function openEditModal(idx) {
  const client = allClients[idx];
  if (!client || !schemaCache) return;

  const f = schemaCache.fields;
  const modal = document.getElementById('add-client-modal');
  modal.classList.remove('hidden');

  const reviewsList = calculateReviews(client, termToDays, bonusToDays);
  const inputCls = 'input-dark w-full bg-[#0a0d13] border border-white/[0.08] rounded-lg px-3 py-2.5 text-[13px] text-[#e2e8f0] focus:outline-none transition-all placeholder-[#4a5568]';

  function selectOpts(options, selected) {
    return options.map(o => `<option value="${o}" ${o === selected ? 'selected' : ''}>${o}</option>`).join('');
  }

  modal.innerHTML = `
    <div class="fixed inset-0 bg-black/60 backdrop-blur-sm z-40" onclick="closeModal()"></div>
    <div class="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div class="modal-panel rounded-2xl w-full max-w-lg max-h-[90vh] overflow-hidden border border-white/[0.06]">
        <div class="px-6 pt-6 pb-4 flex items-center justify-between">
          <h2 class="text-base font-semibold text-white">${client.name}</h2>
          <button onclick="closeModal()" class="text-[#4a5568] hover:text-[#8892a8] text-lg leading-none transition-colors">&times;</button>
        </div>
        <div class="px-6 py-4 overflow-y-auto max-h-[65vh] space-y-6">

          <!-- ── Quick-edit: Name / Health / Flag Reason ──────────────── -->
          <div class="pb-5 mb-1 border-b-2 border-white/[0.08]">
            <div class="space-y-3">
              <div>
                <label class="block text-[12px] font-semibold text-[#8892a8] uppercase tracking-widest mb-1.5 font-mono">Name</label>
                <input type="text" id="edit-name" class="${inputCls} text-base font-semibold" value="${client.name}">
              </div>
              <div>
                <label class="block text-[12px] font-semibold text-[#8892a8] uppercase tracking-widest mb-1.5 font-mono">Health</label>
                <select id="edit-health" class="${inputCls}" onchange="onEditHealthChange(this.value)">
                  ${selectOpts(f.health.options, normaliseHealth(client.health))}
                </select>
              </div>
              <div id="edit-flag-reason-wrap" class="${normaliseHealth(client.health) !== '🚩 Attention' ? 'hidden' : ''}">
                <label class="block text-[12px] font-semibold text-[#8892a8] uppercase tracking-widest mb-1.5 font-mono">Flag Reason <span class="text-[#4a5568] normal-case font-normal">(optional)</span></label>
                <input type="text" id="edit-flag-reason" class="${inputCls}" value="${(client.flag_reason || '').replace(/"/g, '&quot;')}" placeholder="Why is this client flagged?">
              </div>
            </div>
          </div>

          <div>
            <h3 class="text-[11px] font-semibold text-[#4a5568] uppercase tracking-widest mb-3 font-mono">Contract</h3>
            <div class="grid grid-cols-2 gap-3">
              <div>
                <label class="block text-[12px] font-medium text-[#64748b] mb-1">Term</label>
                <select id="edit-term" class="${inputCls}">${selectOpts(f.contract.fields.term.options, client.contract?.term)}</select>
              </div>
              <div>
                <label class="block text-[12px] font-medium text-[#64748b] mb-1">Bonus Term</label>
                <select id="edit-bonus" class="${inputCls}">
                  <option value="">None</option>
                  ${selectOpts(f.contract.fields.bonus_term.options, client.contract?.bonus_term)}
                </select>
              </div>
            </div>
          </div>

          <div>
            <h3 class="text-[11px] font-semibold text-[#4a5568] uppercase tracking-widest mb-3 font-mono">Payment</h3>
            <div class="grid grid-cols-2 gap-3">
              <div>
                <label class="block text-[12px] font-medium text-[#64748b] mb-1">Period</label>
                <select id="edit-period" class="${inputCls}">${selectOpts(f.payment.fields.period.options, client.payment?.period)}</select>
              </div>
              <div>
                <label class="block text-[12px] font-medium text-[#64748b] mb-1">Processor</label>
                <select id="edit-processor" class="${inputCls}">${selectOpts(f.payment.fields.processor.options, client.payment?.processor)}</select>
              </div>
              <div>
                <label class="block text-[12px] font-medium text-[#64748b] mb-1">Currency</label>
                <select id="edit-currency" class="${inputCls}">${selectOpts(f.payment.fields.currency.options, client.payment?.currency)}</select>
              </div>
              <div>
                <label class="block text-[12px] font-medium text-[#64748b] mb-1">Amount</label>
                <input type="number" id="edit-amount" class="${inputCls}" value="${client.payment?.amount ?? ''}" step="any">
              </div>
            </div>
            <div class="flex items-center gap-3 mt-2">
              <input type="checkbox" id="edit-gst" class="w-4 h-4 rounded border-white/[0.15] bg-[#0a0d13] text-indigo-500 focus:ring-indigo-500/20" ${client.payment?.gst ? 'checked' : ''}>
              <label for="edit-gst" class="text-[13px] font-medium text-[#8892a8]">GST Applies</label>
            </div>
          </div>

          <div>
            <h3 class="text-[11px] font-semibold text-[#4a5568] uppercase tracking-widest mb-3 font-mono">Dates</h3>
            <div class="grid grid-cols-2 gap-3">
              <div>
                <label class="block text-[12px] font-medium text-[#64748b] mb-1">Client Start</label>
                <input type="date" id="edit-client-start" class="${inputCls}" value="${client.dates?.client_start || ''}">
              </div>
              <div>
                <label class="block text-[12px] font-medium text-[#64748b] mb-1">Program Start</label>
                <input type="date" id="edit-program-start" class="${inputCls}" value="${client.dates?.program_start || ''}">
              </div>
            </div>
          </div>

          <div>
            <h3 class="text-[11px] font-semibold text-[#4a5568] uppercase tracking-widest mb-3 font-mono">Reviews</h3>
            <ul class="space-y-2 text-sm">
              ${reviewsList.length ? reviewsList.map(r => {
                const dateStr = fmt(r.date);
                if (r.completed) {
                  const doneStr = r.completed_date ? fmt(parseDate(r.completed_date)) : '—';
                  const noteStr = r.notes ? `<br><span class="text-[#4a5568] text-xs ml-4">↳ ${r.notes}</span>` : '';
                  return `<li class="text-[#64748b]">Review ${r.reviewNum}: ${dateStr} <span class="text-emerald-400/60">✓ done ${doneStr}</span>${noteStr}</li>`;
                }
                return `<li class="text-[#e2e8f0]">Review ${r.reviewNum}: ${dateStr} <button type="button" onclick="openReviewModal(${idx}, ${r.reviewNum})" class="ml-2 text-xs text-indigo-400 hover:underline">Complete review</button></li>`;
              }).join('') : (() => {
                const reason = diagnoseMissingReviews(client, termToDays, bonusToDays);
                return reason
                  ? `<li class="text-amber-400/70 text-[12px]">⚠ ${reason}</li>`
                  : '<li class="text-[#4a5568]">No reviews in this term.</li>';
              })()}
            </ul>
          </div>

          ${(client.pause_history && client.pause_history.length > 0) ? `
          <div>
            <h3 class="text-[11px] font-semibold text-[#4a5568] uppercase tracking-widest mb-3 font-mono">Pause History</h3>
            <ul class="space-y-2 text-sm text-[#64748b] font-mono">
              ${client.pause_history.map(entry => {
                const pd = entry.paused_date ? fmt(parseDate(entry.paused_date)) : '—';
                const rd = entry.resumed_date ? fmt(parseDate(entry.resumed_date)) : '—';
                const totalDays = entry.paused_date && entry.resumed_date ? daysDiff(parseDate(entry.paused_date), parseDate(entry.resumed_date)) : 0;
                const w = totalDays ? `${Math.floor(totalDays / 7)}w${totalDays % 7 ? ` ${totalDays % 7}d` : ''}` : (entry.weeks != null ? `~${entry.weeks}w` : '');
                const reason = entry.reason ? ` • ${entry.reason}` : '';
                return `<li>${pd} – ${rd} ${w}${reason}</li>`;
              }).join('')}
            </ul>
          </div>
          ` : ''}

          <div>
            <h3 class="text-[11px] font-semibold text-[#4a5568] uppercase tracking-widest mb-3 font-mono">Client Notes</h3>
            <div class="flex gap-2 mb-3">
              <input type="text" id="new-note-input" class="${inputCls}" placeholder="Add a note… (supports **bold**, *italic*, - bullets)">
              <button type="button" onclick="addNoteFromModal(${idx})" class="btn-primary px-3 py-2 text-[13px] font-semibold text-white rounded-lg whitespace-nowrap">Add</button>
            </div>
            <ul class="space-y-3 max-h-48 overflow-y-auto pr-1">
              ${(client.client_notes && client.client_notes.length > 0)
                ? [...client.client_notes].reverse().map(n => `
                  <li class="border-b border-white/[0.04] pb-2 last:border-0">
                    <div class="text-[11px] text-[#4a5568] font-mono mb-1">${new Date(n.date).toLocaleDateString('en-AU', {day:'numeric',month:'short',year:'2-digit',hour:'2-digit',minute:'2-digit'})}</div>
                    <div class="note-body text-[13px] text-[#8892a8]">${markdownToHtml(n.note)}</div>
                  </li>`).join('')
                : '<li class="text-[#4a5568] text-[13px] font-mono">No notes yet.</li>'}
            </ul>
          </div>

        </div>
        <div class="px-6 py-4 border-t border-white/[0.06] flex justify-between items-center">
          <div class="flex items-center gap-2">
            ${client.status === 'active' ? `
            <button type="button" onclick="showPauseForm(${idx})" class="px-3.5 py-2 text-[13px] font-medium text-[#8892a8] bg-white/[0.04] hover:bg-white/[0.08] rounded-lg transition-colors border border-white/[0.06]">Pause</button>
            ` : client.status === 'paused' ? `
            <button type="button" onclick="confirmResume(${idx})" class="px-3.5 py-2 text-[13px] font-medium text-[#8892a8] bg-white/[0.04] hover:bg-white/[0.08] rounded-lg transition-colors border border-white/[0.06]">Resume</button>
            ` : ''}
            ${client.status === 'active' || client.status === 'paused' ? `
            <button type="button" onclick="confirmArchive(${idx})" class="px-3.5 py-2 text-[13px] font-medium text-[#4a5568] hover:text-rose-400 transition-colors">Archive</button>
            ` : client.status === 'archived' ? `
            <button type="button" onclick="showReactivateForm(${idx})" class="px-3.5 py-2 text-[13px] font-medium text-[#8892a8] bg-white/[0.04] hover:bg-white/[0.08] rounded-lg transition-colors border border-white/[0.06]">Reactivate</button>
            ` : ''}
          </div>
          <button onclick="saveEdit(${idx})" class="px-5 py-2 btn-primary text-[13px] font-semibold text-white rounded-lg">
            Save Changes
          </button>
        </div>
      </div>
    </div>`;
  // Init Flatpickr on all date inputs in this modal
  if (window.flatpickr) {
    ['edit-client-start','edit-program-start'].forEach(id => {
      const el = document.getElementById(id);
      if (el) flatpickr(el, FP_CFG);
    });
  }
}

// ── Health change handler in edit modal ───────────────────────────────────────

function onEditHealthChange(value) {
  const wrap = document.getElementById('edit-flag-reason-wrap');
  if (wrap) wrap.classList.toggle('hidden', normaliseHealth(value) !== '🚩 Attention');
}

function saveEdit(idx) {
  const val = id => document.getElementById(id)?.value || '';
  const num = id => { const v = document.getElementById(id)?.value; return v === '' ? 0 : Number(v); };
  const chk = id => document.getElementById(id)?.checked || false;

  const c = allClients[idx];
  c.name = val('edit-name');

  // Update health from the dropdown
  const newHealth = val('edit-health');
  if (newHealth) {
    const wasAttention = normaliseHealth(c.health) === '🚩 Attention';
    const isAttention  = normaliseHealth(newHealth) === '🚩 Attention';
    if (!isAttention && wasAttention) c.flag_reason = '';
    c.health = newHealth;
  }

  c.contract = {
    ...c.contract,
    term:       val('edit-term'),
    bonus_term: val('edit-bonus') || null,
  };
  c.payment = {
    ...c.payment,
    period:    val('edit-period'),
    currency:  val('edit-currency'),
    amount:    num('edit-amount'),
    gst:       chk('edit-gst'),
    processor: val('edit-processor'),
  };
  c.dates = {
    ...c.dates,
    client_start:  val('edit-client-start'),
    program_start: val('edit-program-start'),
  };
  // Update flag_reason if field is visible
  const flagWrap = document.getElementById('edit-flag-reason-wrap');
  if (flagWrap && !flagWrap.classList.contains('hidden')) {
    c.flag_reason = val('edit-flag-reason');
  }

  saveClients(idx);
  closeModal();
  render();
  renderStats();
  showToast(`${c.name} saved`);
}

// ── Pause / Resume ─────────────────────────────────────────────────────────────

function showPauseForm(idx) {
  const client = allClients[idx];
  if (!client || client.status !== 'active') return;
  const modal = document.getElementById('add-client-modal');
  if (!modal) return;
  modal.classList.remove('hidden');
  const today = todayISO();
  modal.innerHTML = `
    <div class="fixed inset-0 bg-black/60 backdrop-blur-sm z-40" onclick="cancelPauseForm(${idx})"></div>
    <div class="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div class="modal-panel rounded-2xl w-full max-w-lg max-h-[90vh] overflow-hidden border border-white/[0.06]" id="pause-form" data-client-idx="${idx}">
        <div class="px-6 pt-6 pb-4 flex items-center justify-between">
          <h2 class="text-base font-semibold text-white">Pause: ${client.name}</h2>
          <button type="button" onclick="cancelPauseForm(${idx})" class="text-[#4a5568] hover:text-[#8892a8] text-lg leading-none transition-colors">&times;</button>
        </div>
        <div class="px-6 py-5 space-y-4">
          <div>
            <label class="block text-[12px] font-medium text-[#64748b] mb-1">How long?</label>
            <select id="pause-mode" class="input-dark w-full bg-[#0a0d13] border border-white/[0.08] rounded-lg px-3 py-2.5 text-[13px] text-[#e2e8f0] focus:outline-none transition-all" onchange="togglePauseModePanels(); updatePausePreview();">
              <option value="from_today">Duration from today</option>
              <option value="from_date">Duration from date</option>
              <option value="from_to">From – To (date range)</option>
            </select>
          </div>
          <div id="pause-mode-from_today" class="grid grid-cols-2 gap-3">
            <div>
              <label class="block text-[12px] font-medium text-[#64748b] mb-1">Weeks</label>
              <input type="number" id="pause-weeks" min="0" value="2" class="input-dark w-full bg-[#0a0d13] border border-white/[0.08] rounded-lg px-3 py-2.5 text-[13px] text-[#e2e8f0] focus:outline-none transition-all" oninput="updatePausePreview()">
            </div>
            <div>
              <label class="block text-[12px] font-medium text-[#64748b] mb-1">Days</label>
              <input type="number" id="pause-days" min="0" value="0" class="input-dark w-full bg-[#0a0d13] border border-white/[0.08] rounded-lg px-3 py-2.5 text-[13px] text-[#e2e8f0] focus:outline-none transition-all" oninput="updatePausePreview()">
            </div>
          </div>
          <div id="pause-mode-from_date" class="grid grid-cols-2 gap-3 hidden">
            <div>
              <label class="block text-[12px] font-medium text-[#64748b] mb-1">Start date</label>
              <input type="date" id="pause-start-date" class="input-dark w-full bg-[#0a0d13] border border-white/[0.08] rounded-lg px-3 py-2.5 text-[13px] text-[#e2e8f0] focus:outline-none transition-all" value="${today}" onchange="updatePausePreview()">
            </div>
            <div class="col-span-2 grid grid-cols-2 gap-3">
              <div>
                <label class="block text-[12px] font-medium text-[#64748b] mb-1">Weeks</label>
                <input type="number" id="pause-from-weeks" min="0" value="2" class="input-dark w-full bg-[#0a0d13] border border-white/[0.08] rounded-lg px-3 py-2.5 text-[13px] text-[#e2e8f0] focus:outline-none transition-all" oninput="updatePausePreview()">
              </div>
              <div>
                <label class="block text-[12px] font-medium text-[#64748b] mb-1">Days</label>
                <input type="number" id="pause-from-days" min="0" value="0" class="input-dark w-full bg-[#0a0d13] border border-white/[0.08] rounded-lg px-3 py-2.5 text-[13px] text-[#e2e8f0] focus:outline-none transition-all" oninput="updatePausePreview()">
              </div>
            </div>
          </div>
          <div id="pause-mode-from_to" class="grid grid-cols-2 gap-3 hidden">
            <div>
              <label class="block text-[12px] font-medium text-[#64748b] mb-1">From (start)</label>
              <input type="date" id="pause-from-to-start" class="input-dark w-full bg-[#0a0d13] border border-white/[0.08] rounded-lg px-3 py-2.5 text-[13px] text-[#e2e8f0] focus:outline-none transition-all" value="${today}" onchange="updatePausePreview()">
            </div>
            <div>
              <label class="block text-[12px] font-medium text-[#64748b] mb-1">To (end)</label>
              <input type="date" id="pause-from-to-end" class="input-dark w-full bg-[#0a0d13] border border-white/[0.08] rounded-lg px-3 py-2.5 text-[13px] text-[#e2e8f0] focus:outline-none transition-all" value="" onchange="updatePausePreview()">
            </div>
          </div>
          <p class="text-[13px] text-[#e2e8f0] font-mono"><span class="font-medium text-[#4a5568]">Preview:</span> <span id="pause-preview">—</span></p>
          <div>
            <label class="block text-[12px] font-medium text-[#64748b] mb-1">Reason (optional)</label>
            <input type="text" id="pause-reason" class="input-dark w-full bg-[#0a0d13] border border-white/[0.08] rounded-lg px-3 py-2.5 text-[13px] text-[#e2e8f0] focus:outline-none transition-all" placeholder="e.g. travel, injury">
          </div>
        </div>
        <div class="px-6 py-4 border-t border-white/[0.06] flex justify-between">
          <button type="button" onclick="cancelPauseForm(${idx})" class="px-3.5 py-2 text-[13px] font-medium text-[#64748b] hover:text-[#e2e8f0] transition-colors">Cancel</button>
          <button type="button" onclick="submitPauseForm(${idx})" class="px-5 py-2 btn-primary text-[13px] font-semibold text-white rounded-lg">Confirm Pause</button>
        </div>
      </div>
    </div>`;
  const fromToEnd = document.getElementById('pause-from-to-end');
  if (fromToEnd) fromToEnd.min = today;
  togglePauseModePanels();
  updatePausePreview();
  // Init Flatpickr on date inputs so the calendar widget appears
  initAllModalDatepickers();
}

function togglePauseModePanels() {
  const mode = document.getElementById('pause-mode')?.value || 'from_today';
  ['from_today', 'from_date', 'from_to'].forEach(m => {
    const el = document.getElementById('pause-mode-' + m);
    if (el) el.classList.toggle('hidden', m !== mode);
  });
}

// Shared helper: reads the current pause form state and returns { pausedDate, resumedDate } or nulls.
function computePauseDates() {
  const mode = document.getElementById('pause-mode')?.value || 'from_today';
  const today = parseDate(todayISO());
  let pausedDate = null;
  let resumedDate = null;
  if (mode === 'from_today') {
    const weeks = parseInt(document.getElementById('pause-weeks')?.value, 10) || 0;
    const days = parseInt(document.getElementById('pause-days')?.value, 10) || 0;
    pausedDate = today;
    resumedDate = addDays(today, weeks * 7 + days);
  } else if (mode === 'from_date') {
    const startStr = document.getElementById('pause-start-date')?.value;
    const weeks = parseInt(document.getElementById('pause-from-weeks')?.value, 10) || 0;
    const days = parseInt(document.getElementById('pause-from-days')?.value, 10) || 0;
    pausedDate = parseDate(startStr);
    if (pausedDate) resumedDate = addDays(pausedDate, weeks * 7 + days);
  } else if (mode === 'from_to') {
    const startStr = document.getElementById('pause-from-to-start')?.value;
    const endStr = document.getElementById('pause-from-to-end')?.value;
    pausedDate = startStr ? parseDate(startStr) : null;
    resumedDate = endStr ? parseDate(endStr) : null;
  }
  return { pausedDate, resumedDate };
}

function updatePausePreview() {
  const { pausedDate, resumedDate } = computePauseDates();
  const el = document.getElementById('pause-preview');
  if (!el) return;
  if (!pausedDate || !resumedDate || resumedDate < pausedDate) {
    el.textContent = '—';
    return;
  }
  const totalDays = daysDiff(pausedDate, resumedDate);
  const w = Math.floor(totalDays / 7);
  const d = totalDays % 7;
  el.textContent = `${w} week${w !== 1 ? 's' : ''}, ${d} day${d !== 1 ? 's' : ''} paused`;
  const mode = document.getElementById('pause-mode')?.value;
  if (mode === 'from_to') {
    const fromInput = document.getElementById('pause-from-to-start');
    const toInput = document.getElementById('pause-from-to-end');
    if (fromInput?.value && toInput) toInput.min = fromInput.value;
  }
}

function cancelPauseForm(idx) {
  openEditModal(idx);
}

function submitPauseForm(idx) {
  const client = allClients[idx];
  if (!client || client.status !== 'active') return;
  const { pausedDate, resumedDate } = computePauseDates();
  if (!pausedDate || !resumedDate || resumedDate < pausedDate) return;
  const totalDays = daysDiff(pausedDate, resumedDate);
  const weeks = totalDays / 7;
  const reason = document.getElementById('pause-reason')?.value?.trim() || null;
  const pausedStr = pausedDate.toISOString().slice(0, 10);
  const resumedStr = resumedDate.toISOString().slice(0, 10);
  const isFuture = pausedStr > todayISO();

  if (!client.pause_history) client.pause_history = [];
  client.pause_history.push({
    paused_date: pausedStr,
    resumed_date: resumedStr,
    weeks,
    reason,
    health_before_pause: client.health || '🆕 Onboarding',
    ...(isFuture ? { pending: true } : {}),
  });
  // Only update weeks_paused + status if pause starts today or earlier.
  // Future pauses: weeks_paused is applied in checkScheduledPauses() when the date arrives.
  if (!isFuture) {
    client.dates = client.dates || {};
    client.dates.weeks_paused = (client.dates.weeks_paused || 0) + weeks;
    client.status = 'paused';
    client.health = '⏸️ Pause';
  }

  saveClients(idx);
  closeModal();
  render();
  renderStats();
  showToast(isFuture ? `Pause scheduled from ${pausedStr}` : `${client.name} paused`);
}

// ── Scheduled pause checker — call on render to auto-activate/auto-resume ─────

function checkScheduledPauses() {
  const todayStr = todayISO();
  allClients.forEach((client, idx) => {
    if (!client.pause_history || !client.pause_history.length) return;
    const last = client.pause_history[client.pause_history.length - 1];

    // Activate a pending (future-scheduled) pause whose start date has arrived.
    // Apply weeks_paused here (not at scheduling time) so dates don't shift early.
    // Early return to avoid evaluating auto-resume in the same iteration.
    if (client.status === 'active' && last.pending && last.paused_date <= todayStr) {
      client.dates = client.dates || {};
      client.dates.weeks_paused = (client.dates.weeks_paused || 0) + last.weeks;
      client.status = 'paused';
      client.health = '⏸️ Pause';
      delete last.pending;
      saveClients(idx);
      return; // prevent same-iteration double-fire if resumed_date is also past
    }

    // Auto-resume a paused client whose resume date has passed.
    // _autoResumed flag prevents re-firing on every subsequent render.
    if (client.status === 'paused' && last.resumed_date && last.resumed_date <= todayStr && !last._autoResumed) {
      client.status = 'active';
      client.health = last.health_before_pause || '🆕 Onboarding';
      last._autoResumed = true;
      saveClients(idx);
    }
  });
}

function confirmResume(idx) {
  const client = allClients[idx];
  if (!client || client.status !== 'paused') return;
  const history = client.pause_history || [];
  const last = history[history.length - 1];
  const restoreHealth = last?.health_before_pause || '🆕 Onboarding';
  client.status = 'active';
  client.health = restoreHealth;
  saveClients(idx);
  closeModal();
  render();
  renderStats();
}

// ── Renewal workflow ───────────────────────────────────────────────────────────

function openRenewalModal(idx) {
  const client = allClients[idx];
  if (!client || client.renewal?.status !== 'pending') return;
  const modal = document.getElementById('add-client-modal');
  if (!modal) return;
  const inputCls = 'input-dark w-full bg-[#0a0d13] border border-white/[0.08] rounded-lg px-3 py-2.5 text-[13px] text-[#e2e8f0] focus:outline-none transition-all placeholder-[#4a5568]';
  modal.classList.remove('hidden');
  modal.innerHTML = `
    <div class="fixed inset-0 bg-black/60 backdrop-blur-sm z-40" onclick="closeModal()"></div>
    <div class="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div class="modal-panel rounded-2xl w-full max-w-lg border border-white/[0.06]">
        <div class="px-6 pt-6 pb-4 flex items-center justify-between">
          <h2 class="text-base font-semibold text-white">Renewal: ${client.name}</h2>
          <button type="button" onclick="closeModal()" class="text-[#4a5568] hover:text-[#8892a8] text-lg leading-none transition-colors">&times;</button>
        </div>
        <div class="px-6 py-5 space-y-4">
          <div>
            <label class="block text-[12px] font-medium text-[#64748b] mb-1">Outcome</label>
            <select id="renewal-outcome" class="${inputCls}" onchange="toggleRenewalFields()">
              <option value="renewed">Renewed</option>
              <option value="churned">Churned</option>
              <option value="paused">Paused</option>
            </select>
          </div>
          <div id="renewal-renewed-fields" class="space-y-4">
            <div class="grid grid-cols-2 gap-3">
              <div>
                <label class="block text-[12px] font-medium text-[#64748b] mb-1">New Term</label>
                <select id="renewal-term" class="${inputCls}">
                  ${(schemaCache?.fields?.contract?.fields?.term?.options || []).map(o =>
                    `<option value="${o}" ${o === client.contract?.term ? 'selected' : ''}>${o}</option>`
                  ).join('')}
                </select>
              </div>
              <div>
                <label class="block text-[12px] font-medium text-[#64748b] mb-1">New Program Start</label>
                <input type="text" id="renewal-program-start" class="${inputCls}" placeholder="Select date…">
              </div>
            </div>
          </div>
          <div>
            <label class="block text-[12px] font-medium text-[#64748b] mb-1">Notes → saved to Client Notes</label>
            <textarea id="renewal-notes" rows="3" class="${inputCls} resize-none" placeholder="e.g. upgraded to 12mth, keen to keep going…"></textarea>
          </div>
        </div>
        <div class="px-6 py-4 border-t border-white/[0.06] flex justify-end gap-2">
          <button type="button" onclick="closeModal()" class="px-3.5 py-2 text-[13px] font-medium text-[#64748b] hover:text-[#e2e8f0] transition-colors">Cancel</button>
          <button type="button" onclick="submitRenewal(${idx})" class="px-5 py-2 btn-primary text-[13px] font-semibold text-white rounded-lg">Save outcome</button>
        </div>
      </div>
    </div>`;
  // Init Flatpickr on new program start field
  if (window.flatpickr) {
    flatpickr('#renewal-program-start', { ...FP_CFG, defaultDate: client.dates?.program_start || null });
  }
  // Wire outcome toggle
  toggleRenewalFields();
}

function toggleRenewalFields() {
  const outcome = document.getElementById('renewal-outcome')?.value;
  const wrap    = document.getElementById('renewal-renewed-fields');
  if (wrap) wrap.classList.toggle('hidden', outcome !== 'renewed');
}

function submitRenewal(idx) {
  const client       = allClients[idx];
  if (!client) return;
  const outcome      = document.getElementById('renewal-outcome')?.value || 'renewed';
  const notes        = document.getElementById('renewal-notes')?.value?.trim() || null;
  const programStart = document.getElementById('renewal-program-start')?.value || null;
  const term         = document.getElementById('renewal-term')?.value || null;

  client.renewal = { status: outcome, actioned_date: todayISO(), notes: null };

  if (outcome === 'renewed') {
    if (programStart) { client.dates = client.dates || {}; client.dates.program_start = programStart; }
    if (term)           client.contract = { ...client.contract, term };
  }

  // Save renewal notes to client_notes as a timestamped entry
  if (notes) {
    if (!client.client_notes) client.client_notes = [];
    const termLabel = outcome === 'renewed' && term ? ` · ${term}` : '';
    client.client_notes.push({
      id:   crypto.randomUUID(),
      date: new Date().toISOString(),
      note: `**Renewal: ${outcome}${termLabel}**\n${notes}`,
    });
  }

  saveClients(idx);
  closeModal();
  render();
  renderStats();
  showToast(`Renewal saved — ${outcome}`);
}

// ── Archive / Reactivate ──────────────────────────────────────────────────────

function confirmArchive(idx) {
  const client = allClients[idx];
  if (!client || (client.status !== 'active' && client.status !== 'paused')) return;
  client.status = 'archived';
  saveClients(idx);
  closeModal();
  render();
  renderStats();
}

function showReactivateForm(idx) {
  const client = allClients[idx];
  if (!client || client.status !== 'archived') return;
  const modal = document.getElementById('add-client-modal');
  if (!modal) return;
  const f = schemaCache?.fields;
  const inputCls = 'input-dark w-full bg-[#0a0d13] border border-white/[0.08] rounded-lg px-3 py-2.5 text-[13px] text-[#e2e8f0] focus:outline-none transition-all placeholder-[#4a5568]';
  const termOpts = f?.contract?.fields?.term?.options ? f.contract.fields.term.options.map(o => `<option value="${o}" ${o === (client.contract?.term) ? 'selected' : ''}>${o}</option>`).join('') : '';
  modal.classList.remove('hidden');
  modal.innerHTML = `
    <div class="fixed inset-0 bg-black/60 backdrop-blur-sm z-40" onclick="closeModal()"></div>
    <div class="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div class="modal-panel rounded-2xl w-full max-w-lg border border-white/[0.06]">
        <div class="px-6 pt-6 pb-4 flex items-center justify-between">
          <h2 class="text-base font-semibold text-white">Reactivate: ${client.name}</h2>
          <button type="button" onclick="closeModal(); openEditModal(${idx})" class="text-[#4a5568] hover:text-[#8892a8] text-lg leading-none transition-colors">&times;</button>
        </div>
        <div class="px-6 py-5 space-y-4">
          <p class="text-[13px] text-[#64748b]">Set the new program start date and optional contract term. Client will return as active with health "Onboarding".</p>
          <div>
            <label class="block text-[12px] font-medium text-[#64748b] mb-1">New program start</label>
            <input type="date" id="reactivate-program-start" class="${inputCls}" value="${todayISO()}" required>
          </div>
          <div>
            <label class="block text-[12px] font-medium text-[#64748b] mb-1">Contract term (optional)</label>
            <select id="reactivate-term" class="${inputCls}">${termOpts}</select>
          </div>
        </div>
        <div class="px-6 py-4 border-t border-white/[0.06] flex justify-end gap-2">
          <button type="button" onclick="closeModal(); openEditModal(${idx})" class="px-3.5 py-2 text-[13px] font-medium text-[#64748b] hover:text-[#e2e8f0] transition-colors">Cancel</button>
          <button type="button" onclick="submitReactivate(${idx})" class="px-5 py-2 btn-primary text-[13px] font-semibold text-white rounded-lg">Reactivate</button>
        </div>
      </div>
    </div>`;
}

function submitReactivate(idx) {
  const client = allClients[idx];
  if (!client || client.status !== 'archived') return;
  const programStart = document.getElementById('reactivate-program-start')?.value;
  const term = document.getElementById('reactivate-term')?.value;
  if (!programStart) return;
  client.status = 'active';
  client.health = '🆕 Onboarding';
  client.dates = client.dates || {};
  client.dates.program_start = programStart;
  if (term) client.contract = { ...client.contract, term };
  client.renewal = { status: 'pending' };
  saveClients(idx);
  closeModal();
  render();
  renderStats();
}

// ── Toast notifications ────────────────────────────────────────────────────────

function showToast(msg, type = 'success') {
  const container = document.getElementById('toast-container');
  if (!container) return;
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = msg;
  container.appendChild(el);
  setTimeout(() => {
    el.classList.add('fade-out');
    el.addEventListener('animationend', () => el.remove(), { once: true });
  }, 2800);
}

// ── Markdown → safe HTML ──────────────────────────────────────────────────────

function markdownToHtml(text) {
  if (!text) return '';
  let s = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  s = s.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/\*(.+?)\*/g, '<em>$1</em>');
  s = s.replace(/((?:^- .+\n?)+)/gm, match => {
    const items = match.trim().split('\n').map(l => `<li>${l.replace(/^- /, '')}</li>`).join('');
    return `<ul>${items}</ul>`;
  });
  s = s.replace(/\n/g, '<br>');
  return s;
}

// ── Client notes helpers ───────────────────────────────────────────────────────

function addNoteFromModal(idx) {
  const input = document.getElementById('new-note-input');
  if (!input) return;
  const text = input.value.trim();
  if (!text) return;
  const client = allClients[idx];
  if (!client) return;
  if (!client.client_notes) client.client_notes = [];
  client.client_notes.push({ id: crypto.randomUUID(), date: new Date().toISOString(), note: text });
  saveClients(idx);
  showToast('Note added');
  openEditModal(idx);
}

// ── Auto-backup to localStorage ────────────────────────────────────────────────

function autoBackup() {
  if (allClients.length === 0) return;
  try {
    const key  = `clientPulse_backup_${todayISO()}`;
    const data = JSON.stringify({ schema_version: '1.0', backed_up: new Date().toISOString(), clients: allClients });
    localStorage.setItem(key, data);
    const keys = Object.keys(localStorage).filter(k => k.startsWith('clientPulse_backup_')).sort();
    if (keys.length > 5) keys.slice(0, keys.length - 5).forEach(k => localStorage.removeItem(k));
    const el = document.getElementById('backup-status');
    if (el) {
      el.textContent = `✓ ${new Date().toLocaleTimeString('en-AU', { hour: '2-digit', minute: '2-digit' })}`;
      el.classList.remove('hidden');
    }
  } catch (e) { console.warn('Auto-backup failed:', e); }
}

// ── Flatpickr helpers ──────────────────────────────────────────────────────────

const FP_CFG = { dateFormat: 'Y-m-d', disableMobile: true };

function initAllModalDatepickers() {
  if (!window.flatpickr) return;
  document.querySelectorAll('#add-client-modal input[type="date"]').forEach(el => {
    flatpickr(el, FP_CFG);
  });
}

// ── Inline date picker (table cell click) ─────────────────────────────────────

function openInlineDatePicker(td) {
  if (!window.flatpickr) return;
  const field = td.dataset.inlineDate;
  const idx   = parseInt(td.dataset.idx, 10);
  const val   = td.dataset.val || '';
  const origHTML = td.innerHTML;

  const input = document.createElement('input');
  input.type  = 'text';
  input.style.cssText = 'width:0;height:0;opacity:0;position:absolute;pointer-events:none;';
  td.innerHTML = '';
  td.appendChild(input);

  const fp = flatpickr(input, {
    ...FP_CFG,
    defaultDate: val || null,
    onClose(selectedDates, dateStr) {
      if (dateStr && dateStr !== val) {
        const parts = field.split('.');
        let obj = allClients[idx];
        for (let i = 0; i < parts.length - 1; i++) {
          obj[parts[i]] = obj[parts[i]] || {};
          obj = obj[parts[i]];
        }
        obj[parts[parts.length - 1]] = dateStr;
        saveClients(idx);
        showToast('Date updated');
        render();
      } else {
        td.innerHTML = origHTML;
        fp.destroy();
      }
    },
  });
  fp.open();
}

// ── Action Items view ─────────────────────────────────────────────────────────

function renderActionItems() {
  const today       = getToday();
  const weekFromNow = addDays(today, 7);
  const active      = allClients
    .map((c, i) => ({ ...c, _idx: i, _health: normaliseHealth(c.health) }))
    .filter(c => c.status === 'active')
    .filter(c => !searchQuery || c.name.toLowerCase().includes(searchQuery.toLowerCase()));

  const attention  = active.filter(c => c._health === '🚩 Attention');
  const cruising   = active.filter(c => c._health === '🔸 Cruising');
  const renewalsDue = active.filter(c => renewalFlag(c, termToDays, bonusToDays));

  const overdueReviews = [], weekReviews = [];
  active.forEach(c => {
    calculateReviews(c, termToDays, bonusToDays).forEach(r => {
      if (r.completed) return;
      if (r.date < today) overdueReviews.push({ c, r });
      else if (r.date <= weekFromNow) weekReviews.push({ c, r });
    });
  });

  function clientRow(c, sub, sub2) {
    const hc = GANTT_BAR_COLOR[c._health] || GANTT_DEFAULT_COLOR;
    return `<div class="py-2.5 border-b border-white/[0.04] last:border-0 cursor-pointer hover:bg-white/[0.03] rounded-lg px-2 -mx-2 transition-colors" onclick="openEditModal(${c._idx})">
      <div class="flex items-center justify-between">
        <div class="flex items-center gap-2.5 min-w-0">
          <div class="w-1.5 h-1.5 rounded-full flex-shrink-0" style="background:${hc.border};box-shadow:0 0 6px ${hc.border}80;"></div>
          <span class="text-[13px] font-medium text-[#e2e8f0] truncate">${c.name}</span>
        </div>
        ${sub ? `<span class="text-[11px] text-[#64748b] font-mono ml-3 flex-shrink-0">${sub}</span>` : ''}
      </div>
      ${sub2 ? `<div class="text-[11px] text-[#64748b] ml-4 mt-0.5 truncate">↳ ${sub2}</div>` : ''}
    </div>`;
  }

  function card(title, icon, count, rows, danger) {
    const cc = count > 0 ? (danger ? 'text-rose-400' : 'text-amber-400') : 'text-[#4a5568]';
    return `<div class="glass rounded-2xl p-5 depth-1">
      <div class="flex items-center justify-between mb-4">
        <div class="flex items-center gap-2">
          <span>${icon}</span>
          <h3 class="text-[13px] font-semibold text-white">${title}</h3>
        </div>
        <span class="text-[13px] font-mono font-bold ${cc}">${count}</span>
      </div>
      ${rows || '<p class="text-[13px] text-[#4a5568] font-mono">All clear ✓</p>'}
    </div>`;
  }

  // Merged: Flagged (top) + Cruising (below divider)
  const attentionRows = [
    ...attention.map(c => clientRow(c, c.flag_reason || '', '')),
    ...(attention.length > 0 && cruising.length > 0 ? [
      `<div class="border-t border-white/[0.06] my-2 pt-1">
        <span class="text-[10px] font-semibold text-[#4a5568] uppercase tracking-widest font-mono">Cruising</span>
      </div>`
    ] : []),
    ...cruising.map(c => clientRow(c, '→ send encouragement')),
  ].join('');

  // Merged: Overdue reviews (top, with badge) + this week reviews (below divider)
  const overdueRows  = overdueReviews.map(({c, r}) => {
    const daysOver = Math.abs(Math.round((r.date - today) / 86400000));
    return clientRow(c, `R${r.reviewNum} · <span class="text-rose-400">${daysOver}d overdue</span>`);
  });
  const weekRows = weekReviews.map(({c, r}) => {
    const daysUntil = Math.round((r.date - today) / 86400000);
    return clientRow(c, `R${r.reviewNum} · in ${daysUntil}d`);
  });
  const reviewRows = [
    ...overdueRows,
    ...(overdueReviews.length > 0 && weekReviews.length > 0 ? [
      `<div class="border-t border-white/[0.06] my-2 pt-1">
        <span class="text-[10px] font-semibold text-[#4a5568] uppercase tracking-widest font-mono">This Week</span>
      </div>`
    ] : []),
    ...weekRows,
  ].join('');
  const totalReviews = overdueReviews.length + weekReviews.length;

  document.getElementById('actions-inner').innerHTML = `
    <div class="flex items-center gap-3 mb-5">
      <h2 class="text-base font-bold text-white">Action Items</h2>
      <span class="text-[12px] text-[#4a5568] font-mono">${getToday().toLocaleDateString('en-AU',{weekday:'short',day:'numeric',month:'short'})}</span>
    </div>
    <div class="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
      ${card('Needs Attention','🚩', attention.length + cruising.length, attentionRows, attention.length > 0)}
      ${card('Reviews','📅', totalReviews, reviewRows, overdueReviews.length > 0)}
      ${card('Renewals Due','🔄',renewalsDue.length, renewalsDue.map(c=>{
        const rc=renewContact(c,termToDays,bonusToDays);
        const d=rc?Math.round((rc-today)/86400000):null;
        return clientRow(c, d!==null?(d<0?`${Math.abs(d)}d overdue`:`in ${d}d`):'');
      }).join(''), true)}
    </div>`;
}

// ── Bulk Notes (Gemini) ───────────────────────────────────────────────────────

function openBulkNotesModal() {
  const modal = document.getElementById('add-client-modal');
  if (!modal) return;
  modal.classList.remove('hidden');
  const storedKey = localStorage.getItem('cp_gemini_key') || '';
  const inputCls  = 'input-dark w-full bg-[#0a0d13] border border-white/[0.08] rounded-xl px-3 py-2.5 text-[13px] text-[#e2e8f0] focus:outline-none transition-all placeholder-[#4a5568]';

  modal.innerHTML = `
    <div class="fixed inset-0 bg-black/60 backdrop-blur-sm z-40" onclick="closeModal()"></div>
    <div class="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div class="modal-panel rounded-2xl w-full max-w-2xl max-h-[90vh] overflow-hidden border border-white/[0.06]">
        <div class="px-6 pt-6 pb-4 flex items-center justify-between">
          <div>
            <h2 class="text-base font-semibold text-white">Bulk Notes Update</h2>
            <p class="text-[12px] text-[#4a5568] mt-0.5">Dictate notes for multiple clients — AI detects who each note is about.</p>
          </div>
          <button type="button" onclick="closeModal()" class="text-[#4a5568] hover:text-[#8892a8] text-lg transition-colors">&times;</button>
        </div>
        <div class="px-6 py-4 overflow-y-auto max-h-[65vh] space-y-4">
          ${storedKey
            ? `<div class="flex items-center justify-between p-2.5 rounded-lg bg-emerald-500/10 border border-emerald-500/20">
                <span class="text-[12px] text-emerald-400">✓ Gemini API key configured</span>
                <button onclick="localStorage.removeItem('cp_gemini_key');openBulkNotesModal();" class="text-[11px] text-[#4a5568] hover:text-rose-400 transition-colors">Remove</button>
               </div>`
            : `<div class="p-3 rounded-lg bg-amber-500/10 border border-amber-500/20 space-y-2">
                <p class="text-[12px] text-amber-400 font-medium">Gemini API key required (free at aistudio.google.com)</p>
                <input type="text" id="bulk-gemini-key" placeholder="Paste API key here" class="${inputCls}">
                <p class="text-[11px] text-[#4a5568]">Stored in your browser only. Never sent anywhere except Gemini.</p>
               </div>`}
          <div>
            <label class="block text-[12px] font-medium text-[#64748b] mb-1.5">Your dictation</label>
            <textarea id="bulk-notes-text" rows="5" class="${inputCls} resize-none" style="height:auto;"
              placeholder="e.g. Lee crushing it — up 5 pullups. Claire needs to focus on squat depth. Andreas doing well but form slipping on last sets."></textarea>
          </div>
          <div id="bulk-preview" class="hidden space-y-2">
            <h3 class="text-[11px] font-semibold text-[#4a5568] uppercase tracking-widest font-mono">Parsed — confirm before saving</h3>
            <div id="bulk-preview-list" class="space-y-2"></div>
          </div>
          <div id="bulk-error" class="hidden text-rose-400 text-[13px] p-3 rounded-lg bg-rose-500/10 border border-rose-500/20"></div>
        </div>
        <div class="px-6 py-4 border-t border-white/[0.06] flex justify-end gap-2">
          <button type="button" onclick="closeModal()" class="px-3.5 py-2 text-[13px] font-medium text-[#64748b] hover:text-[#e2e8f0] transition-colors">Cancel</button>
          <button type="button" id="btn-parse-notes" onclick="parseBulkNotes()" class="btn-secondary px-4 py-2 text-[13px] font-medium text-[#8892a8] rounded-lg cursor-pointer">Parse with AI</button>
          <button type="button" id="btn-confirm-bulk" onclick="confirmBulkNotes()" class="btn-primary px-5 py-2 text-[13px] font-semibold text-white rounded-lg hidden">Add Notes</button>
        </div>
      </div>
    </div>`;
}

async function parseBulkNotes() {
  const text     = document.getElementById('bulk-notes-text')?.value?.trim();
  const keyInput = document.getElementById('bulk-gemini-key');
  const errorEl  = document.getElementById('bulk-error');
  const parseBtn = document.getElementById('btn-parse-notes');
  errorEl.classList.add('hidden');

  if (keyInput?.value?.trim()) localStorage.setItem('cp_gemini_key', keyInput.value.trim());
  const apiKey = localStorage.getItem('cp_gemini_key');
  if (!apiKey) { errorEl.textContent = 'Enter your Gemini API key first.'; errorEl.classList.remove('hidden'); return; }
  if (!text)   { errorEl.textContent = 'Enter some notes to parse.';        errorEl.classList.remove('hidden'); return; }

  parseBtn.textContent = 'Parsing…';
  parseBtn.disabled    = true;

  const names  = allClients.map(c => c.name);
  const prompt = `Parse this coaching note text and attribute each note to the correct client from the list.
Client list: ${names.join(', ')}
Text: "${text}"
Return ONLY a JSON array: [{"client":"exact name","note":"their note"}]
- Match names fuzzily (nicknames, first names ok).
- If ambiguous, use null for client.
- Only include clients mentioned.
JSON array only:`;

  try {
    const res  = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`,
      { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ contents:[{parts:[{text:prompt}]}] }) });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error?.message || 'Gemini API error');
    const raw   = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
    const match = raw.match(/\[[\s\S]*\]/);
    if (!match) throw new Error('Could not parse AI response. Try rephrasing your notes.');
    const parsed = JSON.parse(match[0]);

    window._bulkPayload = parsed.map(item => {
      const name = (item.client || '').toLowerCase();
      const idx  = allClients.findIndex(c =>
        c.name.toLowerCase() === name ||
        c.name.toLowerCase().includes(name) ||
        name.includes(c.name.split(' ')[0].toLowerCase())
      );
      return { ...item, idx, matched: idx !== -1 };
    });

    document.getElementById('bulk-preview').classList.remove('hidden');
    document.getElementById('btn-confirm-bulk').classList.remove('hidden');
    document.getElementById('bulk-preview-list').innerHTML = window._bulkPayload.map((item, i) => {
      const label = item.matched ? allClients[item.idx].name : (item.client || 'Unknown — no match');
      const cls   = item.matched ? 'border-emerald-500/20 bg-emerald-500/5' : 'border-rose-500/20 bg-rose-500/5';
      const nc    = item.matched ? 'text-emerald-400' : 'text-rose-400';
      return `<div class="p-3 rounded-lg border ${cls} flex items-start gap-3">
        <div class="flex-1 min-w-0">
          <div class="text-[12px] font-semibold ${nc} mb-1">${label}</div>
          <div class="text-[13px] text-[#8892a8]">${item.note}</div>
        </div>
        <button onclick="window._bulkPayload.splice(${i},1);this.closest('div[class*=rounded]').remove();" class="text-[#4a5568] hover:text-rose-400 text-sm transition-colors flex-shrink-0 mt-0.5">✕</button>
      </div>`;
    }).join('');
  } catch(e) {
    errorEl.textContent = e.message || 'Parsing failed.';
    errorEl.classList.remove('hidden');
  } finally {
    parseBtn.textContent = 'Parse with AI';
    parseBtn.disabled    = false;
  }
}

function confirmBulkNotes() {
  const payload = (window._bulkPayload || []).filter(item => item.matched);
  if (!payload.length) { showToast('No matched clients', 'info'); return; }
  payload.forEach(item => {
    const client = allClients[item.idx];
    if (!client) return;
    if (!client.client_notes) client.client_notes = [];
    client.client_notes.push({ id: crypto.randomUUID(), date: new Date().toISOString(), note: item.note });
    saveClients(item.idx);
  });
  closeModal();
  showToast(`Notes added to ${payload.length} client${payload.length !== 1 ? 's' : ''}`);
  window._bulkPayload = null;
}

// ── Auth handlers ─────────────────────────────────────────────────────────────

function showLogin() {
  document.getElementById('login-screen').classList.remove('hidden');
  document.getElementById('app-container').classList.add('hidden');
  setupAuthEvents();
}

function showApp() {
  document.getElementById('login-screen').classList.add('hidden');
  document.getElementById('app-container').classList.remove('hidden');
}

function setupAuthEvents() {
  document.getElementById('btn-sign-in')?.addEventListener('click', handleSignIn);
  document.getElementById('btn-sign-up')?.addEventListener('click', handleSignUp);
  document.getElementById('auth-password')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') handleSignIn();
  });
}

async function handleSignIn() {
  const email    = document.getElementById('auth-email')?.value?.trim();
  const password = document.getElementById('auth-password')?.value;
  const errorEl  = document.getElementById('auth-error');
  errorEl.classList.add('hidden');
  errorEl.classList.remove('text-emerald-400');
  errorEl.classList.add('text-red-400');

  if (!email || !password) {
    errorEl.textContent = 'Email and password required';
    errorEl.classList.remove('hidden');
    return;
  }

  try {
    await sbSignIn(email, password);
    init(); // re-run init — will find session and load app
  } catch (e) {
    errorEl.textContent = e.message || 'Sign in failed';
    errorEl.classList.remove('hidden');
  }
}

async function handleSignUp() {
  const email    = document.getElementById('auth-email')?.value?.trim();
  const password = document.getElementById('auth-password')?.value;
  const errorEl  = document.getElementById('auth-error');
  errorEl.classList.add('hidden');
  errorEl.classList.remove('text-emerald-400');
  errorEl.classList.add('text-red-400');

  if (!email || !password) {
    errorEl.textContent = 'Email and password required';
    errorEl.classList.remove('hidden');
    return;
  }
  if (password.length < 6) {
    errorEl.textContent = 'Password must be at least 6 characters';
    errorEl.classList.remove('hidden');
    return;
  }

  try {
    const result = await sbSignUp(email, password);
    // If Supabase auto-confirms (email confirmation disabled), sign in immediately
    if (result.session) {
      init();
      return;
    }
    errorEl.textContent = 'Account created! Check your email to confirm, then sign in.';
    errorEl.classList.remove('hidden');
    errorEl.classList.remove('text-red-400');
    errorEl.classList.add('text-emerald-400');
  } catch (e) {
    errorEl.textContent = e.message || 'Sign up failed';
    errorEl.classList.remove('hidden');
  }
}

async function handleSignOut() {
  await sbSignOut();
  allClients = [];
  showLogin();
}

// ── Init ──────────────────────────────────────────────────────────────────────

async function init() {
  try {
    // 1. Check auth — if not signed in, show login
    const session = await sbGetSession();
    if (!session) {
      showLogin();
      return;
    }
    showApp();

    // 2. Load schema (static config — same for all coaches)
    const schemaRes = await fetch('schema.json');
    const schema = await schemaRes.json();

    schemaCache  = schema;
    tableColumns = schema.table_columns;
    termToDays   = schema.fields.dates.term_to_days;
    bonusToDays  = schema.fields.dates.bonus_to_days;

    // 3. One-time migration: if localStorage has data and Supabase is empty, auto-migrate
    const localRaw = localStorage.getItem('clientPulse_clients');
    let supaClients = await sbLoadClients(session.user.id);

    if (localRaw && supaClients.length === 0) {
      try {
        const localClients = JSON.parse(localRaw);
        if (localClients.length > 0) {
          console.log(`Migrating ${localClients.length} clients from localStorage to Supabase...`);
          supaClients = await sbSeedClients(localClients, session.user.id);
          localStorage.removeItem('clientPulse_clients');
          console.log('Migration complete.');
        }
      } catch (e) {
        console.warn('Could not migrate localStorage data:', e);
      }
    }

    allClients = supaClients;

    // 5. Build health style maps from schema
    const healthOptions = schema.fields.health.options || [];
    HEALTH_ORDER = {};
    HEALTH_STYLE = {};
    GANTT_BAR_COLOR = {};
    healthOptions.forEach((h, i) => {
      HEALTH_ORDER[h] = i;
      const styles = HEALTH_STYLES_BY_INDEX[i] || HEALTH_STYLES_BY_INDEX[HEALTH_STYLES_BY_INDEX.length - 1];
      HEALTH_STYLE[h] = styles.badge;
      GANTT_BAR_COLOR[h] = styles.gantt;
    });

    // 6. Populate filter dropdowns from schema
    const healthSelect = document.getElementById('filter-health');
    healthSelect.innerHTML = '<option value="">All health</option>';
    (schema.fields.health.options || []).forEach(o => {
      const opt = document.createElement('option');
      opt.value = o; opt.textContent = o;
      healthSelect.appendChild(opt);
    });
    const termSelect = document.getElementById('filter-term');
    termSelect.innerHTML = '<option value="">All terms</option>';
    (schema.fields.contract.fields.term.options || []).forEach(o => {
      const opt = document.createElement('option');
      opt.value = o; opt.textContent = o;
      termSelect.appendChild(opt);
    });

    // 7. Wire buttons
    document.getElementById('btn-add-client')?.addEventListener('click', openAddClientModal);
    document.getElementById('btn-sign-out')?.addEventListener('click', handleSignOut);

    renderHeaders();
    renderStats();
    setupEvents();
    render();
    // Initial backup on session start
    setTimeout(autoBackup, 3000);
  } catch (e) {
    console.error('Init error:', e);
    const tbody = document.getElementById('tbody');
    if (tbody) {
      tbody.innerHTML = `
        <tr><td colspan="99" class="text-center py-12">
          <p class="text-red-400 font-medium mb-2">Could not load data</p>
          <p class="text-gray-500 text-sm">${e.message}</p>
        </td></tr>`;
    }
  }
}

document.addEventListener('DOMContentLoaded', init);
