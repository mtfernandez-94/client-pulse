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
let viewMode = 'table'; // 'table' | 'gantt'

// ── Style maps ────────────────────────────────────────────────────────────────
// Health options come from schema; styles are UI-only and keyed by schema order.
// HEALTH_ORDER, HEALTH_STYLE, and GANTT_BAR_COLOR are built in init() after
// schema loads. Declared here so they're accessible throughout the file.

const HEALTH_STYLES_BY_INDEX = [
  { badge: 'bg-sky-50 text-sky-700 ring-1 ring-sky-200/60',       gantt: { bg: '#e0f2fe', border: '#7dd3fc', text: '#0369a1' } },
  { badge: 'bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200/60', gantt: { bg: '#d1fae5', border: '#6ee7b7', text: '#047857' } },
  { badge: 'bg-amber-50 text-amber-700 ring-1 ring-amber-200/60', gantt: { bg: '#fef3c7', border: '#fcd34d', text: '#b45309' } },
  { badge: 'bg-rose-50 text-rose-700 ring-1 ring-rose-200/60',    gantt: { bg: '#ffe4e6', border: '#fda4af', text: '#be123c' } },
  { badge: 'bg-stone-50 text-stone-500 ring-1 ring-stone-200/60', gantt: { bg: '#f5f5f4', border: '#d6d3d1', text: '#78716c' } },
];

let HEALTH_ORDER = {};
let HEALTH_STYLE = {};
const STATUS_STYLE = {
  active:   'bg-emerald-50 text-emerald-600 ring-1 ring-emerald-200/60',
  paused:   'bg-amber-50 text-amber-600 ring-1 ring-amber-200/60',
  archived: 'bg-stone-50 text-stone-500 ring-1 ring-stone-200/60',
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
  if (!h) return '<span class="text-stone-300">—</span>';
  const cls = HEALTH_STYLE[h] || 'bg-stone-50 text-stone-500';
  return `<span class="inline-flex items-center px-2 py-0.5 rounded-md text-[11px] font-medium ${cls}">${h}</span>`;
}

function statusBadge(s) {
  const cls = STATUS_STYLE[s] || 'bg-stone-50 text-stone-500';
  return `<span class="inline-flex items-center px-2 py-0.5 rounded-md text-[11px] font-medium capitalize ${cls}">${s}</span>`;
}

function flagBadge(type) {
  if (!type) return '';
  if (type === 'overdue') return ' <span class="text-[11px] font-semibold text-rose-600 ml-1.5">Overdue</span>';
  return ' <span class="text-[11px] font-semibold text-amber-600 ml-1.5">This week</span>';
}

function paymentCell(c) {
  const p = c.payment;
  if (!p) return '<span class="text-stone-300">—</span>';
  const cur = p.currency;
  const amt = p.amount;
  if (!cur || typeof cur !== 'string' || cur.length > 4) return '<span class="text-stone-300">—</span>';
  if (amt === 'paid') return `<span class="text-stone-600">${cur} PIF <span class="text-stone-400">✓</span></span>`;
  if (typeof amt !== 'number') return '<span class="text-stone-300">—</span>';
  const gst = p.gst ? '<span class="text-stone-400 ml-0.5">+GST</span>' : '';
  return `<span class="tabular-nums">${cur} ${amt.toLocaleString('en-AU')}</span>${gst}`;
}

// ── Cell renderer ─────────────────────────────────────────────────────────────

const TD = 'px-5 py-3.5 whitespace-nowrap';
const TD_MUTED = `${TD} text-stone-500`;

function renderCell(client, col) {
  const idx = client._idx;

  switch (col.cell_type) {
    case 'name':
      return `<td class="${TD} font-medium text-gray-900">
        <span class="cursor-pointer hover:text-blue-600 transition-colors" onclick="openEditModal(${idx})">${client.name}</span>
      </td>`;

    case 'health_badge': {
      const options = schemaCache?.fields?.health?.options || [];
      const opts = options.map(o => `<option value="${o}" ${o === client._health ? 'selected' : ''}>${o}</option>`).join('');
      return `<td class="${TD}">
        <select onchange="updateHealth(${idx}, this.value)" class="appearance-none bg-transparent border-0 cursor-pointer text-[11px] font-medium focus:ring-0 p-0 text-stone-700">
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
      return `<td class="${TD_MUTED}">${fmt(parseDate(val))}</td>`;
    }

    case 'calc_date': {
      const fn = getCalc(col.key);
      return `<td class="${TD_MUTED}">${fmt(fn?.(client))}</td>`;
    }

    case 'renewal_flag': {
      const rc = renewContact(client, termToDays, bonusToDays);
      const rf = renewalFlag(client, termToDays, bonusToDays);
      const cls = rf ? 'font-medium text-gray-900' : 'text-stone-500';
      const clickable = rf && client.renewal?.status === 'pending' ? ` onclick="openRenewalModal(${idx})" class="cursor-pointer hover:bg-stone-50 rounded-md transition-colors"` : '';
      return `<td class="${TD}"${clickable}><span class="${cls}">${fmt(rc)}</span>${flagBadge(rf)}</td>`;
    }

    case 'review_flag': {
      const nri = nextReviewInfo(client, termToDays, bonusToDays);
      const nr  = nri ? nri.date : null;
      const rvf = reviewFlag(client, termToDays, bonusToDays);
      const cls = rvf ? 'font-medium text-gray-900' : 'text-stone-500';
      const clickable = nri && rvf ? ` onclick="openReviewModal(${idx}, ${nri.reviewNum})" class="cursor-pointer hover:bg-stone-50 rounded-md transition-colors"` : '';
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
      icon.className   = 'sort-icon text-stone-900 ml-0.5';
    } else {
      icon.textContent = '↕';
      icon.className   = 'sort-icon text-stone-300 ml-0.5';
    }
  });
}

// ── Filter button state ───────────────────────────────────────────────────────

function updateFilterButtons() {
  ['active', 'paused', 'archived', 'all'].forEach(s => {
    const btn = document.getElementById(`filter-${s}`);
    if (!btn) return;
    if (s === filterStatus) {
      btn.classList.add('active', 'text-gray-900');
      btn.classList.remove('text-stone-500');
    } else {
      btn.classList.remove('active', 'text-gray-900');
      btn.classList.add('text-stone-500');
    }
  });
}

// ── Header render ─────────────────────────────────────────────────────────────

function renderHeaders() {
  const thead = document.getElementById('thead');
  thead.innerHTML = '<tr class="border-b border-stone-200 text-[11px] font-semibold text-stone-400 uppercase tracking-widest">' +
    tableColumns.map(col => {
      if (!col.sortable) {
        return `<th class="px-5 py-3 text-left whitespace-nowrap font-semibold">${col.label}</th>`;
      }
      const icon = col.sort_key === sortCol
        ? `<span class="sort-icon text-stone-900 ml-0.5">${sortDir === 'asc' ? '↑' : '↓'}</span>`
        : `<span class="sort-icon text-stone-300 ml-0.5">↕</span>`;
      return `<th class="sort-header px-5 py-3 text-left cursor-pointer select-none whitespace-nowrap font-semibold hover:text-stone-600 transition-colors" data-sort="${col.sort_key}">
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
  updateFilterButtons();
  updateSortIcons();
  updateViewToggle();

  const clients = getVisible();
  document.getElementById('row-count').textContent = `${clients.length} client${clients.length !== 1 ? 's' : ''}`;

  if (viewMode === 'gantt') {
    document.getElementById('table-wrap').classList.add('hidden');
    document.getElementById('gantt-wrap').classList.remove('hidden');
    renderGantt();
    return;
  }

  document.getElementById('table-wrap').classList.remove('hidden');
  document.getElementById('gantt-wrap').classList.add('hidden');
  const colspan = tableColumns.length;
  const tbody = document.getElementById('tbody');

  if (clients.length === 0) {
    tbody.innerHTML = `<tr><td colspan="${colspan}" class="text-center text-gray-400 py-12">No clients match this filter.</td></tr>`;
    return;
  }

  tbody.innerHTML = clients.map(c =>
    `<tr class="border-b border-stone-100 hover:bg-stone-50/60 transition-colors">
      ${tableColumns.map(col => renderCell(c, col)).join('')}
    </tr>`
  ).join('');
}

// ── Gantt view ───────────────────────────────────────────────────────────────
// Moved to gantt.js (ClickUp-style with scroll, zoom, and hover tooltips)

// ── Stats bar ─────────────────────────────────────────────────────────────────

function renderStats() {
  const count = s => allClients.filter(c => c.status === s).length;
  document.getElementById('stats').innerHTML =
    `<span class="text-emerald-600">${count('active')} active</span>` +
    `<span class="text-stone-300 mx-2">·</span>` +
    `<span class="text-amber-600">${count('paused')} paused</span>` +
    `<span class="text-stone-300 mx-2">·</span>` +
    `<span class="text-stone-400">${count('archived')} archived</span>`;

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
  document.getElementById('view-table')?.addEventListener('click', () => {
    viewMode = 'table';
    updateViewToggle();
    document.getElementById('table-wrap').classList.remove('hidden');
    document.getElementById('gantt-wrap').classList.add('hidden');
    render();
  });
  document.getElementById('view-gantt')?.addEventListener('click', () => {
    viewMode = 'gantt';
    updateViewToggle();
    document.getElementById('table-wrap').classList.add('hidden');
    document.getElementById('gantt-wrap').classList.remove('hidden');
    renderGantt();
  });
  document.getElementById('btn-export-csv')?.addEventListener('click', exportCSV);
}

function updateViewToggle() {
  ['view-table', 'view-gantt'].forEach(id => {
    const btn = document.getElementById(id);
    if (!btn) return;
    const isTable = id === 'view-table';
    if ((isTable && viewMode === 'table') || (!isTable && viewMode === 'gantt')) {
      btn.classList.add('active', 'text-gray-900');
      btn.classList.remove('text-stone-500');
    } else {
      btn.classList.remove('active', 'text-gray-900');
      btn.classList.add('text-stone-500');
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
  } catch (e) {
    console.error('Could not save to Supabase:', e);
    alert('Warning: changes could not be saved. Check your internet connection.');
  }
}

function updateHealth(idx, value) {
  allClients[idx].health = value;
  saveClients(idx);
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
  const inputCls = 'w-full border border-stone-200 rounded-lg px-3 py-2.5 text-[13px] text-gray-900 focus:ring-2 focus:ring-stone-900/10 focus:border-stone-400 outline-none transition-colors bg-white';
  const reviewDate = fmt(review.date);
  const overdue = review.date < getToday();

  modal.classList.remove('hidden');
  modal.innerHTML = `
    <div class="fixed inset-0 bg-black/30 backdrop-blur-sm z-40" onclick="closeModal()"></div>
    <div class="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div class="bg-white rounded-2xl shadow-2xl w-full max-w-lg ring-1 ring-stone-200/50">
        <div class="px-6 pt-6 pb-4 flex items-center justify-between">
          <h2 class="text-base font-semibold text-gray-900">Review ${reviewNum}: ${client.name}</h2>
          <button type="button" onclick="closeModal()" class="text-stone-400 hover:text-stone-600 text-lg leading-none transition-colors">&times;</button>
        </div>
        <div class="px-6 py-5 space-y-4">
          <div class="flex items-center gap-3 text-[13px]">
            <span class="text-stone-500">Due date:</span>
            <span class="${overdue ? 'font-semibold text-rose-600' : 'text-gray-900'}">${reviewDate}${overdue ? ' (overdue)' : ''}</span>
          </div>
          <div>
            <label class="block text-[12px] font-medium text-stone-500 mb-1">Notes (optional)</label>
            <textarea id="review-notes" class="${inputCls}" rows="3" placeholder="e.g. Progressing well, increase difficulty next block"></textarea>
          </div>
        </div>
        <div class="px-6 py-4 border-t border-stone-100 flex justify-end gap-2">
          <button type="button" onclick="closeModal()" class="px-3.5 py-2 text-[13px] font-medium text-stone-500 hover:text-stone-700 transition-colors">Cancel</button>
          <button type="button" onclick="submitReview(${idx}, ${reviewNum})" class="px-5 py-2 text-[13px] font-semibold text-white bg-gray-900 hover:bg-gray-800 rounded-lg transition-all shadow-sm">Mark complete</button>
        </div>
      </div>
    </div>`;
}

function submitReview(idx, reviewNum) {
  const client = allClients[idx];
  if (!client) return;
  const notes = document.getElementById('review-notes')?.value?.trim() || null;
  const key = `review_${reviewNum}`;
  client.reviews = client.reviews || {};
  client.reviews[key] = {
    ...client.reviews[key],
    completed: true,
    completed_date: todayISO(),
    notes,
  };
  saveClients(idx);
  closeModal();
  render();
  renderStats();
}

function openEditModal(idx) {
  const client = allClients[idx];
  if (!client || !schemaCache) return;

  const f = schemaCache.fields;
  const modal = document.getElementById('add-client-modal');
  modal.classList.remove('hidden');

  const reviewsList = calculateReviews(client, termToDays, bonusToDays);
  const inputCls = 'w-full border border-stone-200 rounded-lg px-3 py-2.5 text-[13px] text-gray-900 focus:ring-2 focus:ring-stone-900/10 focus:border-stone-400 outline-none transition-colors bg-white placeholder-stone-400';

  function selectOpts(options, selected) {
    return options.map(o => `<option value="${o}" ${o === selected ? 'selected' : ''}>${o}</option>`).join('');
  }

  modal.innerHTML = `
    <div class="fixed inset-0 bg-black/30 backdrop-blur-sm z-40" onclick="closeModal()"></div>
    <div class="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div class="bg-white rounded-2xl shadow-2xl w-full max-w-lg max-h-[90vh] overflow-hidden ring-1 ring-stone-200/50">
        <div class="px-6 pt-6 pb-4 flex items-center justify-between">
          <h2 class="text-base font-semibold text-gray-900">${client.name}</h2>
          <button onclick="closeModal()" class="text-stone-400 hover:text-stone-600 text-lg leading-none transition-colors">&times;</button>
        </div>
        <div class="px-6 py-4 overflow-y-auto max-h-[65vh] space-y-6">

          <div>
            <h3 class="text-[11px] font-semibold text-stone-400 uppercase tracking-widest mb-3">Client</h3>
            <div>
              <label class="block text-[12px] font-medium text-stone-500 mb-1">Name</label>
              <input type="text" id="edit-name" class="${inputCls}" value="${client.name}">
            </div>
          </div>

          <div>
            <h3 class="text-[11px] font-semibold text-stone-400 uppercase tracking-widest mb-3">Contract</h3>
            <div class="grid grid-cols-2 gap-3">
              <div>
                <label class="block text-[12px] font-medium text-stone-500 mb-1">Term</label>
                <select id="edit-term" class="${inputCls} bg-white">${selectOpts(f.contract.fields.term.options, client.contract?.term)}</select>
              </div>
              <div>
                <label class="block text-[12px] font-medium text-stone-500 mb-1">Bonus Term</label>
                <select id="edit-bonus" class="${inputCls} bg-white">
                  <option value="">None</option>
                  ${selectOpts(f.contract.fields.bonus_term.options, client.contract?.bonus_term)}
                </select>
              </div>
            </div>
          </div>

          <div>
            <h3 class="text-[11px] font-semibold text-stone-400 uppercase tracking-widest mb-3">Payment</h3>
            <div class="grid grid-cols-2 gap-3">
              <div>
                <label class="block text-[12px] font-medium text-stone-500 mb-1">Period</label>
                <select id="edit-period" class="${inputCls} bg-white">${selectOpts(f.payment.fields.period.options, client.payment?.period)}</select>
              </div>
              <div>
                <label class="block text-[12px] font-medium text-stone-500 mb-1">Processor</label>
                <select id="edit-processor" class="${inputCls} bg-white">${selectOpts(f.payment.fields.processor.options, client.payment?.processor)}</select>
              </div>
              <div>
                <label class="block text-[12px] font-medium text-stone-500 mb-1">Currency</label>
                <select id="edit-currency" class="${inputCls} bg-white">${selectOpts(f.payment.fields.currency.options, client.payment?.currency)}</select>
              </div>
              <div>
                <label class="block text-[12px] font-medium text-stone-500 mb-1">Amount</label>
                <input type="number" id="edit-amount" class="${inputCls}" value="${client.payment?.amount ?? ''}" step="any">
              </div>
            </div>
            <div class="flex items-center gap-3 mt-2">
              <input type="checkbox" id="edit-gst" class="w-4 h-4 rounded border-stone-300 text-gray-900 focus:ring-stone-900/20" ${client.payment?.gst ? 'checked' : ''}>
              <label for="edit-gst" class="text-[13px] font-medium text-stone-600">GST Applies</label>
            </div>
          </div>

          <div>
            <h3 class="text-[11px] font-semibold text-stone-400 uppercase tracking-widest mb-3">Dates</h3>
            <div class="grid grid-cols-2 gap-3">
              <div>
                <label class="block text-[12px] font-medium text-stone-500 mb-1">Client Start</label>
                <input type="date" id="edit-client-start" class="${inputCls}" value="${client.dates?.client_start || ''}">
              </div>
              <div>
                <label class="block text-[12px] font-medium text-stone-500 mb-1">Program Start</label>
                <input type="date" id="edit-program-start" class="${inputCls}" value="${client.dates?.program_start || ''}">
              </div>
            </div>
          </div>

          <div>
            <h3 class="text-[11px] font-semibold text-stone-400 uppercase tracking-widest mb-3">Reviews</h3>
            <ul class="space-y-2 text-sm">
              ${reviewsList.length ? reviewsList.map(r => {
                const dateStr = fmt(r.date);
                if (r.completed) {
                  const doneStr = r.completed_date ? fmt(parseDate(r.completed_date)) : '—';
                  const noteStr = r.notes ? `<br><span class="text-stone-400 text-xs ml-4">↳ ${r.notes}</span>` : '';
                  return `<li class="text-gray-500">Review ${r.reviewNum}: ${dateStr} <span class="text-gray-400">✓ done ${doneStr}</span>${noteStr}</li>`;
                }
                return `<li class="text-gray-700">Review ${r.reviewNum}: ${dateStr} <button type="button" onclick="openReviewModal(${idx}, ${r.reviewNum})" class="ml-2 text-xs text-blue-600 hover:underline">Complete review</button></li>`;
              }).join('') : '<li class="text-gray-400">No reviews in this term.</li>'}
            </ul>
          </div>

          ${(client.pause_history && client.pause_history.length > 0) ? `
          <div>
            <h3 class="text-[11px] font-semibold text-stone-400 uppercase tracking-widest mb-3">Pause History</h3>
            <ul class="space-y-2 text-sm text-gray-600">
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

        </div>
        <div class="px-6 py-4 border-t border-stone-100 flex justify-between items-center">
          <div class="flex items-center gap-2">
            ${client.status === 'active' ? `
            <button type="button" onclick="showPauseForm(${idx})" class="px-3.5 py-2 text-[13px] font-medium text-stone-600 bg-stone-100 hover:bg-stone-200 rounded-lg transition-colors">Pause</button>
            ` : client.status === 'paused' ? `
            <button type="button" onclick="confirmResume(${idx})" class="px-3.5 py-2 text-[13px] font-medium text-stone-600 bg-stone-100 hover:bg-stone-200 rounded-lg transition-colors">Resume</button>
            ` : ''}
            ${client.status === 'active' || client.status === 'paused' ? `
            <button type="button" onclick="confirmArchive(${idx})" class="px-3.5 py-2 text-[13px] font-medium text-stone-400 hover:text-stone-600 transition-colors">Archive</button>
            ` : client.status === 'archived' ? `
            <button type="button" onclick="showReactivateForm(${idx})" class="px-3.5 py-2 text-[13px] font-medium text-stone-600 bg-stone-100 hover:bg-stone-200 rounded-lg transition-colors">Reactivate</button>
            ` : ''}
          </div>
          <button onclick="saveEdit(${idx})" class="px-5 py-2 text-[13px] font-semibold text-white bg-gray-900 hover:bg-gray-800 rounded-lg transition-all shadow-sm">
            Save Changes
          </button>
        </div>
      </div>
    </div>`;
}

function saveEdit(idx) {
  const val = id => document.getElementById(id)?.value || '';
  const num = id => { const v = document.getElementById(id)?.value; return v === '' ? 0 : Number(v); };
  const chk = id => document.getElementById(id)?.checked || false;

  const c = allClients[idx];
  c.name = val('edit-name');
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

  saveClients(idx);
  closeModal();
  render();
  renderStats();
}

// ── Pause / Resume ─────────────────────────────────────────────────────────────

function showPauseForm(idx) {
  const client = allClients[idx];
  if (!client || client.status !== 'active') return;
  const modal = document.getElementById('add-client-modal');
  if (!modal) return;
  const today = todayISO();
  modal.innerHTML = `
    <div class="fixed inset-0 bg-black/30 backdrop-blur-sm z-40" onclick="cancelPauseForm(${idx})"></div>
    <div class="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div class="bg-white rounded-2xl shadow-2xl w-full max-w-lg max-h-[90vh] overflow-hidden ring-1 ring-stone-200/50" id="pause-form" data-client-idx="${idx}">
        <div class="px-6 pt-6 pb-4 flex items-center justify-between">
          <h2 class="text-base font-semibold text-gray-900">Pause: ${client.name}</h2>
          <button type="button" onclick="cancelPauseForm(${idx})" class="text-stone-400 hover:text-stone-600 text-lg leading-none transition-colors">&times;</button>
        </div>
        <div class="px-6 py-5 space-y-4">
          <div>
            <label class="block text-[12px] font-medium text-stone-500 mb-1">How long?</label>
            <select id="pause-mode" class="w-full border border-stone-200 rounded-lg px-3 py-2.5 text-[13px] text-gray-900 focus:ring-2 focus:ring-stone-900/10 focus:border-stone-400 outline-none transition-colors bg-white" onchange="togglePauseModePanels(); updatePausePreview();">
              <option value="from_today">Duration from today</option>
              <option value="from_date">Duration from date</option>
              <option value="from_to">From – To (date range)</option>
            </select>
          </div>
          <div id="pause-mode-from_today" class="grid grid-cols-2 gap-3">
            <div>
              <label class="block text-[12px] font-medium text-stone-500 mb-1">Weeks</label>
              <input type="number" id="pause-weeks" min="0" value="2" class="w-full border border-stone-200 rounded-lg px-3 py-2.5 text-[13px] text-gray-900 focus:ring-2 focus:ring-stone-900/10 focus:border-stone-400 outline-none transition-colors bg-white" oninput="updatePausePreview()">
            </div>
            <div>
              <label class="block text-[12px] font-medium text-stone-500 mb-1">Days</label>
              <input type="number" id="pause-days" min="0" value="0" class="w-full border border-stone-200 rounded-lg px-3 py-2.5 text-[13px] text-gray-900 focus:ring-2 focus:ring-stone-900/10 focus:border-stone-400 outline-none transition-colors bg-white" oninput="updatePausePreview()">
            </div>
          </div>
          <div id="pause-mode-from_date" class="grid grid-cols-2 gap-3 hidden">
            <div>
              <label class="block text-[12px] font-medium text-stone-500 mb-1">Start date</label>
              <input type="date" id="pause-start-date" class="w-full border border-stone-200 rounded-lg px-3 py-2.5 text-[13px] text-gray-900 focus:ring-2 focus:ring-stone-900/10 focus:border-stone-400 outline-none transition-colors bg-white" value="${today}" onchange="updatePausePreview()">
            </div>
            <div class="col-span-2 grid grid-cols-2 gap-3">
              <div>
                <label class="block text-[12px] font-medium text-stone-500 mb-1">Weeks</label>
                <input type="number" id="pause-from-weeks" min="0" value="2" class="w-full border border-stone-200 rounded-lg px-3 py-2.5 text-[13px] text-gray-900 focus:ring-2 focus:ring-stone-900/10 focus:border-stone-400 outline-none transition-colors bg-white" oninput="updatePausePreview()">
              </div>
              <div>
                <label class="block text-[12px] font-medium text-stone-500 mb-1">Days</label>
                <input type="number" id="pause-from-days" min="0" value="0" class="w-full border border-stone-200 rounded-lg px-3 py-2.5 text-[13px] text-gray-900 focus:ring-2 focus:ring-stone-900/10 focus:border-stone-400 outline-none transition-colors bg-white" oninput="updatePausePreview()">
              </div>
            </div>
          </div>
          <div id="pause-mode-from_to" class="grid grid-cols-2 gap-3 hidden">
            <div>
              <label class="block text-[12px] font-medium text-stone-500 mb-1">From (start)</label>
              <input type="date" id="pause-from-to-start" class="w-full border border-stone-200 rounded-lg px-3 py-2.5 text-[13px] text-gray-900 focus:ring-2 focus:ring-stone-900/10 focus:border-stone-400 outline-none transition-colors bg-white" value="${today}" onchange="updatePausePreview()">
            </div>
            <div>
              <label class="block text-[12px] font-medium text-stone-500 mb-1">To (end)</label>
              <input type="date" id="pause-from-to-end" class="w-full border border-stone-200 rounded-lg px-3 py-2.5 text-[13px] text-gray-900 focus:ring-2 focus:ring-stone-900/10 focus:border-stone-400 outline-none transition-colors bg-white" value="" onchange="updatePausePreview()">
            </div>
          </div>
          <p class="text-[13px] text-stone-600"><span class="font-medium text-stone-400">Preview:</span> <span id="pause-preview">—</span></p>
          <div>
            <label class="block text-[12px] font-medium text-stone-500 mb-1">Reason (optional)</label>
            <input type="text" id="pause-reason" class="w-full border border-stone-200 rounded-lg px-3 py-2.5 text-[13px] text-gray-900 focus:ring-2 focus:ring-stone-900/10 focus:border-stone-400 outline-none transition-colors bg-white" placeholder="e.g. travel, injury">
          </div>
        </div>
        <div class="px-6 py-4 border-t border-stone-100 flex justify-between">
          <button type="button" onclick="cancelPauseForm(${idx})" class="px-3.5 py-2 text-[13px] font-medium text-stone-500 hover:text-stone-700 transition-colors">Cancel</button>
          <button type="button" onclick="submitPauseForm(${idx})" class="px-5 py-2 text-[13px] font-semibold text-white bg-gray-900 hover:bg-gray-800 rounded-lg transition-all shadow-sm">Confirm Pause</button>
        </div>
      </div>
    </div>`;
  const fromToEnd = document.getElementById('pause-from-to-end');
  if (fromToEnd) fromToEnd.min = today;
  togglePauseModePanels();
  updatePausePreview();
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

  if (!client.pause_history) client.pause_history = [];
  client.pause_history.push({
    paused_date: pausedStr,
    resumed_date: resumedStr,
    weeks,
    reason,
    health_before_pause: client.health || '🆕 Onboarding',
  });
  client.dates = client.dates || {};
  client.dates.weeks_paused = (client.dates.weeks_paused || 0) + weeks;
  client.status = 'paused';
  client.health = '⏸️ Pause';

  saveClients(idx);
  closeModal();
  render();
  renderStats();
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
  const inputCls = 'w-full border border-stone-200 rounded-lg px-3 py-2.5 text-[13px] text-gray-900 focus:ring-2 focus:ring-stone-900/10 focus:border-stone-400 outline-none transition-colors bg-white';
  modal.classList.remove('hidden');
  modal.innerHTML = `
    <div class="fixed inset-0 bg-black/30 backdrop-blur-sm z-40" onclick="closeModal()"></div>
    <div class="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div class="bg-white rounded-2xl shadow-2xl w-full max-w-lg ring-1 ring-stone-200/50">
        <div class="px-6 pt-6 pb-4 flex items-center justify-between">
          <h2 class="text-base font-semibold text-gray-900">Renewal: ${client.name}</h2>
          <button type="button" onclick="closeModal()" class="text-stone-400 hover:text-stone-600 text-lg leading-none transition-colors">&times;</button>
        </div>
        <div class="px-6 py-5 space-y-4">
          <div>
            <label class="block text-[12px] font-medium text-stone-500 mb-1">Outcome</label>
            <select id="renewal-outcome" class="${inputCls} bg-white">
              <option value="renewed">Renewed</option>
              <option value="churned">Churned</option>
              <option value="paused">Paused</option>
            </select>
          </div>
          <div id="renewal-program-start-wrap">
            <label class="block text-[12px] font-medium text-stone-500 mb-1">New program start (new term)</label>
            <input type="date" id="renewal-program-start" class="${inputCls}" value="${client.dates?.program_start || ''}">
          </div>
          <div>
            <label class="block text-[12px] font-medium text-stone-500 mb-1">Notes (optional)</label>
            <input type="text" id="renewal-notes" class="${inputCls}" placeholder="e.g. upgraded to 12mth">
          </div>
        </div>
        <div class="px-6 py-4 border-t border-stone-100 flex justify-end gap-2">
          <button type="button" onclick="closeModal()" class="px-3.5 py-2 text-[13px] font-medium text-stone-500 hover:text-stone-700 transition-colors">Cancel</button>
          <button type="button" onclick="submitRenewal(${idx})" class="px-5 py-2 text-[13px] font-semibold text-white bg-gray-900 hover:bg-gray-800 rounded-lg transition-all shadow-sm">Save outcome</button>
        </div>
      </div>
    </div>`;
}

function submitRenewal(idx) {
  const client = allClients[idx];
  if (!client) return;
  const outcome = document.getElementById('renewal-outcome')?.value || 'renewed';
  const notes = document.getElementById('renewal-notes')?.value?.trim() || null;
  const programStart = document.getElementById('renewal-program-start')?.value || null;
  client.renewal = {
    status: outcome,
    actioned_date: todayISO(),
    notes,
  };
  if (outcome === 'renewed' && programStart) {
    client.dates = client.dates || {};
    client.dates.program_start = programStart;
  }
  saveClients(idx);
  closeModal();
  render();
  renderStats();
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
  const inputCls = 'w-full border border-stone-200 rounded-lg px-3 py-2.5 text-[13px] text-gray-900 focus:ring-2 focus:ring-stone-900/10 focus:border-stone-400 outline-none transition-colors bg-white';
  const termOpts = f?.contract?.fields?.term?.options ? f.contract.fields.term.options.map(o => `<option value="${o}" ${o === (client.contract?.term) ? 'selected' : ''}>${o}</option>`).join('') : '';
  modal.classList.remove('hidden');
  modal.innerHTML = `
    <div class="fixed inset-0 bg-black/30 backdrop-blur-sm z-40" onclick="closeModal()"></div>
    <div class="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div class="bg-white rounded-2xl shadow-2xl w-full max-w-lg ring-1 ring-stone-200/50">
        <div class="px-6 pt-6 pb-4 flex items-center justify-between">
          <h2 class="text-base font-semibold text-gray-900">Reactivate: ${client.name}</h2>
          <button type="button" onclick="closeModal(); openEditModal(${idx})" class="text-stone-400 hover:text-stone-600 text-lg leading-none transition-colors">&times;</button>
        </div>
        <div class="px-6 py-5 space-y-4">
          <p class="text-[13px] text-stone-500">Set the new program start date and optional contract term. Client will return as active with health "Onboarding".</p>
          <div>
            <label class="block text-[12px] font-medium text-stone-500 mb-1">New program start</label>
            <input type="date" id="reactivate-program-start" class="${inputCls}" value="${todayISO()}" required>
          </div>
          <div>
            <label class="block text-[12px] font-medium text-stone-500 mb-1">Contract term (optional)</label>
            <select id="reactivate-term" class="${inputCls} bg-white">${termOpts}</select>
          </div>
        </div>
        <div class="px-6 py-4 border-t border-stone-100 flex justify-end gap-2">
          <button type="button" onclick="closeModal(); openEditModal(${idx})" class="px-3.5 py-2 text-[13px] font-medium text-stone-500 hover:text-stone-700 transition-colors">Cancel</button>
          <button type="button" onclick="submitReactivate(${idx})" class="px-5 py-2 text-[13px] font-semibold text-white bg-gray-900 hover:bg-gray-800 rounded-lg transition-all shadow-sm">Reactivate</button>
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
  errorEl.classList.remove('text-emerald-600');
  errorEl.classList.add('text-red-500');

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
  errorEl.classList.remove('text-emerald-600');
  errorEl.classList.add('text-red-500');

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
    errorEl.classList.remove('text-red-500');
    errorEl.classList.add('text-emerald-600');
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
    let supaClients = await sbLoadClients();

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

    // 4. If still empty, offer to import seed data
    if (allClients.length === 0) {
      try {
        const seedRes = await fetch('clients_seed.json');
        const seedData = await seedRes.json();
        if (seedData.clients && seedData.clients.length > 0) {
          const doSeed = confirm('No clients found. Import sample data to get started?');
          if (doSeed) {
            allClients = await sbSeedClients(seedData.clients, session.user.id);
          }
        }
      } catch (e) {
        console.log('No seed file available, starting fresh.');
      }
    }

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
  } catch (e) {
    console.error('Init error:', e);
    const tbody = document.getElementById('tbody');
    if (tbody) {
      tbody.innerHTML = `
        <tr><td colspan="99" class="text-center py-12">
          <p class="text-red-500 font-medium mb-2">Could not load data</p>
          <p class="text-gray-500 text-sm">${e.message}</p>
        </td></tr>`;
    }
  }
}

document.addEventListener('DOMContentLoaded', init);
