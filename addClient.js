'use strict';

// ── addClient.js ──────────────────────────────────────────────────────────────
// Single-step modal for adding a new client.
// Auto-assigns: status = "active", health = "🆕 Onboarding"
// Fields: Name, Contract (term + bonus), Payment (all), Dates (client_start + program_start)

// Uses global schemaCache from app.js (set during init)

// ── Form field builder ───────────────────────────────────────────────────────

function buildField(id, def) {
  const label = def.label || id;
  const note  = def.note ? `<p class="text-[11px] text-stone-400 mt-1">${def.note}</p>` : '';
  const req   = def.required ? '<span class="text-rose-400 ml-0.5">*</span>' : '';

  let input = '';
  const inputCls = 'w-full border border-stone-200 rounded-lg px-3 py-2.5 text-[13px] text-gray-900 focus:ring-2 focus:ring-stone-900/10 focus:border-stone-400 outline-none transition-colors bg-white placeholder-stone-400';

  switch (def.type) {
    case 'string':
      input = `<input type="text" id="${id}" class="${inputCls}" placeholder="${label}">`;
      break;
    case 'enum': {
      const defaultOpt = def.required
        ? `<option value="" disabled selected>Select…</option>`
        : `<option value="">None</option>`;
      const opts = (def.options || []).map(o => `<option value="${o}">${o}</option>`).join('');
      input = `<select id="${id}" class="${inputCls} bg-white">${defaultOpt}${opts}</select>`;
      break;
    }
    case 'number':
      input = `<input type="number" id="${id}" class="${inputCls}" placeholder="0" step="any">`;
      break;
    case 'date':
      input = `<input type="date" id="${id}" class="${inputCls}" value="${todayISO()}">`;
      break;
    case 'boolean':
      return `
        <div class="flex items-center gap-3 py-2">
          <input type="checkbox" id="${id}" class="w-4 h-4 rounded border-stone-300 text-gray-900 focus:ring-stone-900/20" ${def.default ? 'checked' : ''}>
          <label for="${id}" class="text-[13px] font-medium text-stone-600">${label}${req}</label>
          ${note}
        </div>`;
    default:
      input = `<input type="text" id="${id}" class="${inputCls}" placeholder="${label}">`;
  }

  return `
    <div>
      <label for="${id}" class="block text-[12px] font-medium text-stone-500 mb-1">${label}${req}</label>
      ${input}
      ${note}
    </div>`;
}

// todayISO() is defined in dateEngine.js (loaded before this file)

// ── Render modal ─────────────────────────────────────────────────────────────

function renderAddModal() {
  const f = schemaCache.fields;
  const modal = document.getElementById('add-client-modal');

  modal.innerHTML = `
    <div class="fixed inset-0 bg-black/30 backdrop-blur-sm z-40" onclick="closeModal()"></div>
    <div class="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div class="bg-white rounded-2xl shadow-2xl w-full max-w-lg max-h-[90vh] overflow-hidden ring-1 ring-stone-200/50">

        <div class="px-6 pt-6 pb-4 flex items-center justify-between">
          <h2 class="text-base font-semibold text-gray-900">Add New Client</h2>
          <button onclick="closeModal()" class="text-stone-400 hover:text-stone-600 text-lg leading-none transition-colors">&times;</button>
        </div>

        <div class="px-6 py-4 overflow-y-auto max-h-[65vh] space-y-6">

          <div>
            <h3 class="text-[11px] font-semibold text-stone-400 uppercase tracking-widest mb-3">Client</h3>
            <div class="space-y-3">
              ${buildField('add-name', f.name)}
            </div>
          </div>

          <div>
            <h3 class="text-[11px] font-semibold text-stone-400 uppercase tracking-widest mb-3">Contract</h3>
            <div class="grid grid-cols-2 gap-3">
              ${buildField('add-term', f.contract.fields.term)}
              ${buildField('add-bonus', f.contract.fields.bonus_term)}
            </div>
          </div>

          <div>
            <h3 class="text-[11px] font-semibold text-stone-400 uppercase tracking-widest mb-3">Payment</h3>
            <div class="grid grid-cols-2 gap-3">
              ${buildField('add-period', f.payment.fields.period)}
              ${buildField('add-processor', f.payment.fields.processor)}
              ${buildField('add-currency', f.payment.fields.currency)}
              ${buildField('add-amount', f.payment.fields.amount)}
            </div>
            <div class="mt-2">
              ${buildField('add-gst', f.payment.fields.gst)}
            </div>
          </div>

          <div>
            <h3 class="text-[11px] font-semibold text-stone-400 uppercase tracking-widest mb-3">Dates</h3>
            <div class="grid grid-cols-2 gap-3">
              ${buildField('add-client-start', f.dates.fields.client_start)}
              ${buildField('add-program-start', f.dates.fields.program_start)}
            </div>
          </div>

          <div id="add-error" class="text-red-500 text-sm hidden"></div>
        </div>

        <div class="px-6 py-4 border-t border-stone-100 flex justify-end">
          <button onclick="submitNewClient()" class="px-5 py-2 text-[13px] font-semibold text-white bg-gray-900 hover:bg-gray-800 rounded-lg transition-all shadow-sm">
            Add Client
          </button>
        </div>

      </div>
    </div>`;
}

// ── Validation ───────────────────────────────────────────────────────────────

function validateAddForm() {
  const errorEl = document.getElementById('add-error');
  errorEl.classList.add('hidden');
  const missing = [];

  const required = [
    ['add-name', 'Name'],
    ['add-term', 'Contract Term'],
    ['add-period', 'Payment Period'],
    ['add-currency', 'Currency'],
    ['add-amount', 'Amount'],
    ['add-processor', 'Processor'],
    ['add-client-start', 'Client Start Date'],
    ['add-program-start', 'Program Start Date'],
  ];

  for (const [id, label] of required) {
    const el = document.getElementById(id);
    if (!el || !el.value) missing.push(label);
  }

  if (missing.length > 0) {
    errorEl.textContent = `Required: ${missing.join(', ')}`;
    errorEl.classList.remove('hidden');
    return false;
  }
  return true;
}

// ── Submit ────────────────────────────────────────────────────────────────────

async function submitNewClient() {
  if (!validateAddForm()) return;

  const val = id => document.getElementById(id)?.value || '';
  const num = id => { const v = document.getElementById(id)?.value; return v === '' ? 0 : Number(v); };
  const chk = id => document.getElementById(id)?.checked || false;

  const client = {
    name:   val('add-name'),
    status: 'active',                // auto-assigned
    health: '🆕 Onboarding',         // auto-assigned
    payment: {
      period:    val('add-period'),
      currency:  val('add-currency'),
      amount:    num('add-amount'),
      gst:       chk('add-gst'),
      processor: val('add-processor'),
    },
    contract: {
      term:       val('add-term'),
      bonus_term: val('add-bonus') || null,
    },
    dates: {
      client_start:  val('add-client-start'),
      program_start: val('add-program-start'),
      weeks_paused:  0,
    },
    renewal:       { status: 'pending' },
    reviews:       {},
    pause_history: [],
    notes:         '',
  };

  try {
    const session = await sbGetSession();
    if (!session) { alert('Not signed in.'); return; }
    const saved = await sbInsertClient(client, session.user.id);
    allClients.push(saved); // push version with Supabase-generated id
  } catch (e) {
    console.error('Could not save new client:', e);
    alert('Error saving client. Check your connection and try again.');
    return;
  }

  closeModal();
  render();
  renderStats();
}

// ── Open / close ─────────────────────────────────────────────────────────────

function openAddClientModal() {
  const modal = document.getElementById('add-client-modal');
  modal.classList.remove('hidden');
  renderAddModal();
}

function closeModal() {
  const modal = document.getElementById('add-client-modal');
  modal.innerHTML = '';
  modal.classList.add('hidden');
}
