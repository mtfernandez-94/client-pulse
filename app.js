'use strict';

// ── State ────────────────────────────────────────────────────────────────────

let allClients   = [];
let tableColumns = [];   // from schema.json
let termToDays   = {};   // from schema.json — e.g. { '12wks': 84, '16wks': 112, ... }
let bonusToDays  = {};   // from schema.json — e.g. { '1mth': 30, '2mth': 61 }
let filterStatus = 'active';
let filterHealth = '';
let filterTerm   = '';
let sortCol = 'renewalUrgency';
let sortDir = 'asc';

// ── Style maps ────────────────────────────────────────────────────────────────

const HEALTH_ORDER = { '✅ Momentum': 0, '🔸 Cruising': 1, '🚩 Attention': 2, '⏸️ Pause': 3 };
const HEALTH_STYLE = {
  '✅ Momentum': 'bg-emerald-100 text-emerald-800',
  '🔸 Cruising': 'bg-amber-100 text-amber-800',
  '🚩 Attention': 'bg-red-100 text-red-800',
  '⏸️ Pause':    'bg-slate-100 text-slate-600',
};
const STATUS_STYLE = {
  active:   'bg-green-100 text-green-700',
  paused:   'bg-orange-100 text-orange-700',
  archived: 'bg-gray-100 text-gray-500',
};

// ── Calculated field dispatch ─────────────────────────────────────────────────
// Each CALC function wraps the dateEngine call, passing in schema config.

function getCalc(key) {
  const fns = {
    'calc.end_of_commitment': c => endOfCommitment(c, termToDays, bonusToDays),
    'calc.renew_contact':     c => renewContact(c, termToDays, bonusToDays),
    'calc.next_review':       c => nextReview(c, termToDays, bonusToDays),
  };
  return fns[key] || null;
}

// ── Filter & sort ─────────────────────────────────────────────────────────────

function getVisible() {
  let list = allClients.map(c => ({ ...c, _health: normaliseHealth(c.health) }));

  if (filterStatus !== 'all') list = list.filter(c => c.status === filterStatus);
  if (filterHealth)            list = list.filter(c => c._health === filterHealth);
  if (filterTerm)              list = list.filter(c => c.contract?.term === filterTerm);

  list.sort((a, b) => {
    let diff = 0;
    switch (sortCol) {
      case 'name':
        diff = a.name.localeCompare(b.name); break;
      case 'health':
        diff = (HEALTH_ORDER[a._health] ?? 99) - (HEALTH_ORDER[b._health] ?? 99); break;
      case 'renewalUrgency':
        diff = urgencyScore(a, termToDays, bonusToDays) - urgencyScore(b, termToDays, bonusToDays); break;
      case 'endDate': {
        const ea = endOfCommitment(a, termToDays, bonusToDays)?.getTime() ?? 9e15;
        const eb = endOfCommitment(b, termToDays, bonusToDays)?.getTime() ?? 9e15;
        diff = ea - eb; break;
      }
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
  if (!h) return '<span class="text-gray-300">—</span>';
  const cls = HEALTH_STYLE[h] || 'bg-gray-100 text-gray-500';
  return `<span class="inline-flex px-2 py-0.5 rounded-full text-xs font-medium ${cls}">${h}</span>`;
}

function statusBadge(s) {
  const cls = STATUS_STYLE[s] || 'bg-gray-100 text-gray-500';
  return `<span class="inline-flex px-2 py-0.5 rounded-full text-xs font-medium ${cls}">${s}</span>`;
}

function flagBadge(type) {
  if (!type) return '';
  if (type === 'overdue') return ' <span class="text-xs font-bold text-red-600">⚠️ OVERDUE</span>';
  return ' <span class="text-xs font-semibold text-amber-600">🔔 THIS WEEK</span>';
}

function paymentCell(c) {
  const p = c.payment;
  if (!p) return '<span class="text-gray-300">—</span>';
  const cur = p.currency;
  const amt = p.amount;
  if (!cur || typeof cur !== 'string' || cur.length > 4) return '<span class="text-gray-300">—</span>';
  if (amt === 'paid') return `<span class="text-gray-600">${cur} PIF ✓</span>`;
  if (typeof amt !== 'number') return '<span class="text-gray-300">—</span>';
  const gst    = p.gst ? ' <span class="text-gray-400">+GST</span>' : '';
  const period = p.period && p.period.length < 15 ? ` <span class="text-gray-400">${p.period}</span>` : '';
  return `${cur} ${amt.toLocaleString('en-AU')}${period}${gst}`;
}

// ── Cell renderer ─────────────────────────────────────────────────────────────

const TD = 'px-4 py-3 whitespace-nowrap';
const TD_MUTED = `${TD} text-gray-600`;

function renderCell(client, col) {
  switch (col.cell_type) {
    case 'name':
      return `<td class="${TD} font-medium">${client.name}</td>`;

    case 'health_badge':
      return `<td class="${TD}">${healthBadge(client._health)}</td>`;

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
      const cls = rf ? 'font-medium text-gray-900' : 'text-gray-600';
      return `<td class="${TD}"><span class="${cls}">${fmt(rc)}</span>${flagBadge(rf)}</td>`;
    }

    case 'review_flag': {
      const nr  = nextReview(client, termToDays, bonusToDays);
      const rvf = reviewFlag(client, termToDays, bonusToDays);
      const cls = rvf ? 'font-medium text-gray-900' : 'text-gray-600';
      return `<td class="${TD}"><span class="${cls}">${fmt(nr)}</span>${flagBadge(rvf)}</td>`;
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
      icon.className   = 'sort-icon text-blue-500';
    } else {
      icon.textContent = '↕';
      icon.className   = 'sort-icon text-gray-300';
    }
  });
}

// ── Filter button state ───────────────────────────────────────────────────────

function updateFilterButtons() {
  ['active', 'paused', 'archived', 'all'].forEach(s => {
    const btn = document.getElementById(`filter-${s}`);
    if (!btn) return;
    if (s === filterStatus) {
      btn.classList.add('bg-white', 'shadow', 'ring-2', 'ring-blue-400', 'text-gray-900');
      btn.classList.remove('text-gray-600');
    } else {
      btn.classList.remove('bg-white', 'shadow', 'ring-2', 'ring-blue-400', 'text-gray-900');
      btn.classList.add('text-gray-600');
    }
  });
}

// ── Header render ─────────────────────────────────────────────────────────────

function renderHeaders() {
  const thead = document.getElementById('thead');
  thead.innerHTML = '<tr class="border-b-2 border-gray-200 bg-gray-50 text-xs font-semibold text-gray-500 uppercase tracking-wider">' +
    tableColumns.map(col => {
      if (!col.sortable) {
        return `<th class="px-4 py-3 text-left whitespace-nowrap">${col.label}</th>`;
      }
      const icon = col.sort_key === sortCol
        ? `<span class="sort-icon text-blue-500">${sortDir === 'asc' ? '↑' : '↓'}</span>`
        : `<span class="sort-icon text-gray-300">↕</span>`;
      return `<th class="sort-header px-4 py-3 text-left cursor-pointer select-none whitespace-nowrap" data-sort="${col.sort_key}">
        ${col.label} ${icon}
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

  const clients = getVisible();
  const colspan = tableColumns.length;
  document.getElementById('row-count').textContent = `${clients.length} client${clients.length !== 1 ? 's' : ''}`;

  const tbody = document.getElementById('tbody');

  if (clients.length === 0) {
    tbody.innerHTML = `<tr><td colspan="${colspan}" class="text-center text-gray-400 py-12">No clients match this filter.</td></tr>`;
    return;
  }

  tbody.innerHTML = clients.map(c =>
    `<tr class="border-b border-gray-100 hover:bg-blue-50 transition-colors">
      ${tableColumns.map(col => renderCell(c, col)).join('')}
    </tr>`
  ).join('');
}

// ── Stats bar ─────────────────────────────────────────────────────────────────

function renderStats() {
  const count = s => allClients.filter(c => c.status === s).length;
  document.getElementById('stats').innerHTML =
    `<span class="text-green-700 font-medium">${count('active')} active</span>` +
    `<span class="text-gray-300 mx-2">|</span>` +
    `<span class="text-orange-600 font-medium">${count('paused')} paused</span>` +
    `<span class="text-gray-300 mx-2">|</span>` +
    `<span class="text-gray-500 font-medium">${count('archived')} archived</span>`;

  document.getElementById('today-display').textContent =
    'Today: ' + TODAY.toLocaleDateString('en-AU', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
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
}

// ── Init ──────────────────────────────────────────────────────────────────────

async function init() {
  try {
    const [schemaRes, clientsRes] = await Promise.all([
      fetch('schema.json'),
      fetch('clients_seed.json'),
    ]);
    const schema = await schemaRes.json();
    const data   = await clientsRes.json();

    // Load schema config — date engine reads these, not hardcoded constants
    tableColumns = schema.table_columns;
    termToDays   = schema.fields.dates.term_to_days;
    bonusToDays  = schema.fields.dates.bonus_to_days;
    allClients   = data.clients;

    renderHeaders();
    renderStats();
    setupEvents();
    render();
  } catch (e) {
    document.getElementById('tbody').innerHTML = `
      <tr><td colspan="9" class="text-center py-12">
        <p class="text-red-500 font-medium mb-2">Could not load data files</p>
        <p class="text-gray-500 text-sm">Run a local server first:</p>
        <code class="bg-gray-100 px-3 py-1.5 rounded text-sm mt-2 inline-block">python3 -m http.server 8080</code>
        <p class="text-gray-400 text-sm mt-2">Then open <strong>http://localhost:8080</strong></p>
      </td></tr>`;
  }
}

document.addEventListener('DOMContentLoaded', init);
