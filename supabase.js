'use strict';

// ── Supabase Configuration ────────────────────────────────────────────────
// These are safe to expose client-side. Row-Level Security protects data.
// Replace with your Supabase project values (Settings > API in the dashboard).
const SUPABASE_URL = 'YOUR_SUPABASE_URL';
const SUPABASE_ANON_KEY = 'YOUR_SUPABASE_ANON_KEY';

// Initialise Supabase client (supabase-js loaded via CDN in index.html)
const sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// ── Auth Functions ────────────────────────────────────────────────────────

async function sbSignUp(email, password) {
  const { data, error } = await sb.auth.signUp({ email, password });
  if (error) throw error;
  return data;
}

async function sbSignIn(email, password) {
  const { data, error } = await sb.auth.signInWithPassword({ email, password });
  if (error) throw error;
  return data;
}

async function sbSignOut() {
  const { error } = await sb.auth.signOut();
  if (error) throw error;
}

async function sbGetSession() {
  const { data: { session }, error } = await sb.auth.getSession();
  if (error) throw error;
  return session;
}

// ── Data Mapping ──────────────────────────────────────────────────────────
// Convert between Supabase rows and the in-memory client objects the app uses.

function rowToClient(row) {
  return {
    id:            row.id,
    name:          row.name,
    status:        row.status,
    health:        row.health,
    payment:       row.payment || {},
    contract:      row.contract || {},
    dates:         row.dates || {},
    reviews:       row.reviews || {},
    renewal:       row.renewal || { status: 'pending' },
    pause_history: row.pause_history || [],
    notes:         row.notes || '',
  };
}

function clientToRow(client, coachId) {
  const row = {
    coach_id:      coachId,
    name:          client.name,
    status:        client.status,
    health:        client.health,
    payment:       client.payment || {},
    contract:      client.contract || {},
    dates:         client.dates || {},
    reviews:       client.reviews || {},
    renewal:       client.renewal || { status: 'pending' },
    pause_history: client.pause_history || [],
    notes:         client.notes || '',
  };
  if (client.id) row.id = client.id;
  return row;
}

// ── Data CRUD ─────────────────────────────────────────────────────────────

async function sbLoadClients() {
  const { data, error } = await sb
    .from('clients')
    .select('*')
    .order('name');
  if (error) throw error;
  return (data || []).map(rowToClient);
}

async function sbSaveClient(client, coachId) {
  if (!client.id) return;
  const row = clientToRow(client, coachId);
  const { error } = await sb
    .from('clients')
    .update(row)
    .eq('id', client.id);
  if (error) throw error;
}

async function sbInsertClient(client, coachId) {
  const row = clientToRow(client, coachId);
  delete row.id; // let Supabase generate the UUID
  const { data, error } = await sb
    .from('clients')
    .insert(row)
    .select()
    .single();
  if (error) throw error;
  return rowToClient(data);
}

async function sbSeedClients(clients, coachId) {
  const rows = clients.map(c => {
    const r = clientToRow(c, coachId);
    delete r.id;
    return r;
  });
  const { data, error } = await sb
    .from('clients')
    .insert(rows)
    .select();
  if (error) throw error;
  return (data || []).map(rowToClient);
}
