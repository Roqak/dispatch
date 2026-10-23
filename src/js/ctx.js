// Controller: tabs, saving, running. Views call these; app.js wires rendering.

import * as S from './store.js';
import { state, emit } from './store.js';
import { bridge } from './bridge.js';
import { clone, uuid, findItem, findParentList, newRequestItem, newFolder, isFolder, itemId, duplicateItem, urlObject, effectiveAuth } from './model.js';
import { Scope, Resolver } from './vars.js';
import { execute, buildOutgoing } from './send.js';
import { toast, confirmDialog, errText } from './ui/dom.js';

export const libs = () => ({ chai: globalThis.chai, CryptoJS: globalThis.CryptoJS, lodash: globalThis._ });

// ---------- tabs ----------

export const wsTabs = () => state.tabs.filter((t) => t.ws === state.ws?.id);
export const activeTab = () => wsTabs().find((t) => t.id === state.activeTab) || null;

export function focusTab(id) {
  state.activeTab = id;
  S.saveTabs();
  emit('tabs', 'main');
}

function addTab(tab) {
  const t = { id: uuid(), ws: state.ws.id, sub: 'params', respTab: 'body', scriptTab: 'prerequest', dirty: false, ...tab };
  // Insert after the active tab, like a browser.
  const cur = state.tabs.findIndex((x) => x.id === state.activeTab);
  state.tabs.splice(cur >= 0 ? cur + 1 : state.tabs.length, 0, t);
  focusTab(t.id);
  return t;
}

export const emitTabs = () => emit('tabs');
export const emitAll = () => emit('all');
export const saveTabsLater = () => S.saveTabs();

export function findTab(pred) { return wsTabs().find(pred); }

export async function openItem(entry, itemIdArg) {
  await S.ensureCollection(entry);
  const found = findItem(entry.data, itemIdArg);
  if (!found) return;
  const existing = findTab((t) => t.kind === 'request' && t.ref?.col === entry.uid && t.ref?.item === itemIdArg);
  if (existing) return focusTab(existing.id);
  addTab({ kind: 'request', ref: { col: entry.uid, item: itemIdArg }, draft: clone(found.item) });
}

export function openDraft(item = newRequestItem('Untitled Request')) {
  return addTab({ kind: 'request', ref: null, draft: item, dirty: false });
}

export async function openContainer(entry, folderId = null) {
  await S.ensureCollection(entry);
  const existing = findTab((t) => t.kind === 'container' && t.ref?.col === entry.uid && t.ref?.item === folderId);
  if (existing) return focusTab(existing.id);
  addTab({ kind: 'container', sub: 'overview', ref: { col: entry.uid, item: folderId }, draft: containerDraft(entry, folderId) });
}

function containerDraft(entry, folderId) {
  const src = folderId ? findItem(entry.data, folderId)?.item : entry.data;
  if (!src) return null;
  const pick = (o) => ({ name: folderId ? o.name : o.info?.name, description: folderId ? o.description : o.info?.description, auth: clone(o.auth), event: clone(o.event), variable: clone(o.variable) });
  return pick(src);
}

export async function openEnv(env) {
  try { await S.ensureEnvironment(env); } catch (e) {
    if (!env.data) { toast(`Couldn't load "${env.name}" from Postman: ${errText(e)}`, { error: true }); return; }
    toast(errText(e), { error: true });
  }
  const existing = findTab((t) => t.kind === 'env' && t.ref?.env === env.uid);
  if (existing) return focusTab(existing.id);
  addTab({ kind: 'env', ref: { env: env.uid }, draft: { name: env.name, values: clone(env.data?.values || []) } });
}

export function openGlobals() {
  const existing = findTab((t) => t.kind === 'globals');
  if (existing) return focusTab(existing.id);
  addTab({ kind: 'globals', ref: {}, draft: { name: 'Globals', values: clone(state.ws.globals.values || []) } });
}

export function openRunner(entry, folderId = null) {
  const existing = findTab((t) => t.kind === 'runner' && t.ref?.col === entry.uid && (t.ref?.item ?? null) === (folderId ?? null));
  if (existing) return focusTab(existing.id);
  addTab({ kind: 'runner', ref: { col: entry.uid, item: folderId }, draft: { name: 'Runner' } });
}

export async function closeTab(id, { force = false } = {}) {
  const t = state.tabs.find((x) => x.id === id);
  if (!t) return;
  if (t.dirty && !force) {
    const r = await confirmDialog({ title: 'Save changes?', message: `"${tabTitle(t)}" has unsaved changes.`, confirm: 'Save', cancel: 'Cancel', extra: { label: "Don't save", value: 'discard' } });
    if (!r) return;
    if (r === true) { const ok = await saveTab(t); if (!ok) return; }
  }
  const list = wsTabs();
  const idx = list.findIndex((x) => x.id === id);
  state.tabs = state.tabs.filter((x) => x.id !== id);
  if (state.activeTab === id) {
    const rest = wsTabs();
    state.activeTab = rest[Math.min(idx, rest.length - 1)]?.id || null;
  }
  S.saveTabs();
  emit('tabs', 'main');
}

export function tabTitle(t) {
  if (t.kind === 'globals') return 'Globals';
  return t.draft?.name || 'Untitled';
}

export function markDirty(t) {
  if (!t.dirty) { t.dirty = true; emit('tabs'); }
  S.saveTabs();
}

/** When a collection re-syncs, refresh clean tabs so they show the latest version. */
export function refreshCleanTabs() {
  for (const t of wsTabs()) {
    if (t.dirty) continue;
    if (t.kind === 'request' && t.ref?.col) {
      const e = S.collectionEntry(t.ref.col);
      const f = e?.data && findItem(e.data, t.ref.item);
      if (f) t.draft = clone(f.item);
    } else if (t.kind === 'env') {
      const env = state.ws.environments.find((x) => x.uid === t.ref.env);
      if (env?.data) t.draft = { name: env.name, values: clone(env.data.values) };
    } else if (t.kind === 'container') {
      const e = S.collectionEntry(t.ref.col);
      if (e?.data) t.draft = containerDraft(e, t.ref.item) || t.draft;
    }
  }
}

// ---------- context for a tab ----------

export function contextFor(t) {
  if (!t?.ref?.col) return { entry: null, collection: null, parents: [] };
  const entry = S.collectionEntry(t.ref.col);
  if (!entry?.data) return { entry, collection: null, parents: [] };
  const f = t.ref.item ? findItem(entry.data, t.ref.item) : null;
  return { entry, collection: entry.data, parents: f?.parents || [], item: f?.item };
}

export function scopesFor(t) {
  const ws = state.ws;
  const env = S.activeEnvEntry();
  const { entry, collection } = contextFor(t);
  const changed = () => S.overlaysChanged();
  if (env) env.overlay = env.overlay || {};
  let colOverlay = {};
  if (entry) colOverlay = ws.colOverlays[entry.uid] = ws.colOverlays[entry.uid] || {};
  const colVars = t?.kind === 'container' && !t.ref.item ? t.draft.variable || [] : collection?.variable || [];
  return {
    local: new Scope([], {}),
    environment: new Scope(env?.data?.values || [], env?.overlay || {}, changed, env?.name),
    collection: new Scope(colVars, colOverlay, changed, collection?.info?.name),
    globals: new Scope(ws.globals.values || [], ws.globals.overlay || (ws.globals.overlay = {}), changed, 'Globals'),
  };
}

export const resolverFor = (t) => new Resolver(scopesFor(t));

// ---------- running ----------

export async function run(t) {
  if (t.running) return;
  t.running = true;
  t.response = null;
  emit('response', 'tabs');
  const { collection, parents } = contextFor(t);
  const started = Date.now();
  let result;
  try {
    result = await execute({
      item: t.draft,
      parents,
      collection,
      scopes: scopesFor(t),
      settings: state.settings,
      send: (req) => bridge.send(req),
      libs: libs(),
    });
  } catch (e) {
    result = { error: errText(e), logs: [], tests: [], notes: [], scriptErrors: [] };
  }
  t.running = false;
  t.response = { ...result, at: started };
  if (result.response && t.respTab === 'tests' && !result.tests.length) t.respTab = 'body';
  if (result.tests?.length && result.tests.some((x) => x.passed === false) && t.respTab === 'body') { /* keep on body */ }
  S.overlaysChanged();
  S.addHistory({
    name: t.draft.name,
    method: t.draft.request?.method || 'GET',
    url: result.outgoing?.url || urlObject(t.draft.request?.url).raw,
    status: result.response?.status ?? null,
    timeMs: result.response?.timeMs ?? null,
    error: result.error || null,
    request: clone(t.draft.request),
    ref: t.ref ? { ...t.ref } : null,
  });
  emit('response', 'tabs', 'env-values');
}

export function curlFor(t) {
  const { collection, parents } = contextFor(t);
  const req = t.draft.request;
  const { auth } = effectiveAuth(req, parents, collection);
  const o = buildOutgoing(req, auth, resolverFor(t), state.settings);
  const q = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
  const parts = [`curl --location --request ${o.method} ${q(o.url)}`];
  for (const hd of o.headers) if (hd.key !== 'Accept' || hd.value !== '*/*') parts.push(`--header ${q(`${hd.key}: ${hd.value}`)}`);
  if (o.body.mode === 'raw') parts.push(`--data-raw ${q(o.body.content)}`);
  if (o.body.mode === 'urlencoded') for (const f of o.body.fields) parts.push(`--data-urlencode ${q(`${f.key}=${f.value}`)}`);
  if (o.body.mode === 'formdata') for (const f of o.body.fields) parts.push(`--form ${q(f.kind === 'file' ? `${f.key}=@"${f.src}"` : `${f.key}=${f.value}`)}`);
  if (o.body.mode === 'file') parts.push(`--data-binary ${q(`@${o.body.path}`)}`);
  return parts.join(' \\\n  ');
}

// ---------- saving ----------

/** Returns true when the tab ended up saved. */
export async function saveTab(t) {
  try {
    if (t.kind === 'request') return await saveRequest(t);
    if (t.kind === 'container') return await saveContainer(t);
    if (t.kind === 'env') return await saveEnv(t);
    if (t.kind === 'globals') return await saveGlobals(t);
  } catch (e) {
    if (e instanceof S.ConflictError) return handleConflict(e);
    toast(errText(e), { error: true });
    // Local save succeeded even if pushing failed.
    return !t.dirty;
  }
  return false;
}

async function saveRequest(t) {
  if (!t.ref?.col) {
    const { saveAsDialog } = await import('./ui/panels.js');
    const target = await saveAsDialog(t.draft.name);
    if (!target) return false;
    return saveRequestInto(t, target.entry, target.folderId, target.name);
  }
  const entry = S.collectionEntry(t.ref.col);
  if (!entry) throw new Error('That collection is no longer in this workspace. Use Save As to keep this request.');
  await S.ensureCollection(entry);
  const loc = findParentList(entry.data, t.ref.item);
  const saved = clone(t.draft);
  if (loc) loc.list[loc.index] = saved;
  else (entry.data.item = entry.data.item || []).push(saved);
  t.dirty = false;
  emit('tabs');
  S.saveTabs();
  toastSync(entry, S.collectionChanged(entry));
  return true;
}

export async function saveRequestInto(t, entry, folderId, name) {
  await S.ensureCollection(entry);
  const item = clone(t.draft);
  item.id = uuid();
  delete item.uid;
  item.name = name || item.name;
  (item.response || []).forEach((r) => { r.id = uuid(); delete r.uid; });
  const list = folderId ? findItem(entry.data, folderId).item.item : (entry.data.item = entry.data.item || []);
  list.push(item);
  t.draft = clone(item);
  t.ref = { col: entry.uid, item: item.id };
  t.dirty = false;
  expandPath(entry, folderId);
  emit('tabs', 'main');
  S.saveTabs();
  toastSync(entry, S.collectionChanged(entry));
  return true;
}

async function saveContainer(t) {
  const entry = S.collectionEntry(t.ref.col);
  await S.ensureCollection(entry);
  const target = t.ref.item ? findItem(entry.data, t.ref.item)?.item : entry.data;
  if (!target) throw new Error('This folder no longer exists.');
  const d = t.draft;
  const setOrDelete = (obj, k, v) => { if (v === undefined || v === null || (Array.isArray(v) && !v.length)) delete obj[k]; else obj[k] = clone(v); };
  if (t.ref.item) {
    target.name = d.name;
    setOrDelete(target, 'description', d.description || undefined);
  } else {
    target.info.name = d.name;
    setOrDelete(target.info, 'description', d.description || undefined);
    setOrDelete(target, 'variable', (d.variable || []).filter((v) => v.key));
  }
  setOrDelete(target, 'auth', d.auth);
  setOrDelete(target, 'event', d.event);
  t.dirty = false;
  emit('tabs');
  S.saveTabs();
  toastSync(entry, S.collectionChanged(entry));
  return true;
}

async function saveEnv(t) {
  const env = state.ws.environments.find((e) => e.uid === t.ref.env);
  if (!env) throw new Error('This environment no longer exists.');
  if (!env.data && S.isCloud() && !env.pendingCreate) throw new Error(`"${env.name}" hasn't loaded from Postman yet, so saving now could erase its values. Sync and try again.`);
  env.name = t.draft.name;
  env.data = { ...(env.data || {}), name: t.draft.name, values: clone(t.draft.values.filter((v) => v.key)) };
  t.dirty = false;
  emit('tabs');
  S.saveTabs();
  await S.environmentChanged(env);
  if (S.isCloud() && state.settings.syncMode === 'auto') toast('Environment saved and synced to Postman');
  return true;
}

async function saveGlobals(t) {
  state.ws.globals.values = clone(t.draft.values.filter((v) => v.key));
  state.ws.globals.dirty = true;
  t.dirty = false;
  emit('tabs', 'env');
  S.saveWorkspace();
  if (S.isCloud() && state.settings.syncMode === 'auto' && state.hasKey) { await S.pushGlobals(); toast('Globals saved and synced to Postman'); }
  return true;
}

function toastSync(entry, pushPromise) {
  Promise.resolve(pushPromise).then(() => {
    if (S.isCloud() && state.settings.syncMode === 'auto' && !entry.dirty) toast('Saved and synced to Postman');
    else if (S.isCloud() && entry.dirty) toast('Saved locally. Push when you\'re ready.');
    else toast('Saved');
  }, (e) => {
    if (e instanceof S.ConflictError) handleConflict(e);
    else toast(`Saved locally, but syncing failed: ${errText(e)}`, { error: true, action: { label: 'Retry', onClick: () => pushNow(entry) } });
  });
}

export async function pushNow(entry, { quiet = false, ws = state.ws } = {}) {
  try {
    await S.pushCollection(entry, { ws });
    if (!quiet) toast(`"${entry.name}" synced to Postman`);
  } catch (e) {
    if (e instanceof S.ConflictError) return handleConflict(e);
    toast(errText(e), { error: true });
  }
}

export async function handleConflict(err) {
  const { entry, kind } = err;
  const what = kind === 'globals' ? 'the globals' : `"${entry.name}"`;
  const choice = await confirmDialog({
    title: 'Changed in Postman',
    message: `${what[0].toUpperCase()}${what.slice(1)} changed in Postman after you last synced. Overwrite Postman's version with yours, or load theirs?${kind === 'collection' ? ' If you load theirs, your open tabs keep your edits so you can re-apply them.' : ''}`,
    confirm: 'Overwrite with mine',
    danger: true,
    cancel: 'Decide later',
    extra: { label: 'Load theirs', value: 'theirs' },
  });
  try {
    if (choice === true) {
      if (kind === 'environment') await S.pushEnvironment(entry, { force: true });
      else if (kind === 'globals') await S.pushGlobals({ force: true });
      else await S.pushCollection(entry, { force: true });
      toast(`${what[0].toUpperCase()}${what.slice(1)} synced to Postman`);
      return true;
    }
    if (choice === 'theirs') {
      if (kind === 'environment') {
        await S.pullEnvironment(entry, { discard: true });
        for (const t of wsTabs()) if (t.kind === 'env' && t.ref.env === entry.uid) { t.dirty = false; }
      } else if (kind === 'globals') {
        state.ws.globals.dirty = false;
        delete state.ws.globals.conflict;
        await S.refreshWorkspace();
        for (const t of wsTabs()) if (t.kind === 'globals') { t.dirty = false; t.draft = { name: 'Globals', values: clone(state.ws.globals.values) }; }
      } else {
        for (const t of wsTabs()) if (t.ref?.col === entry.uid && t.kind === 'request') t.dirty = true;
        await S.pullCollection(entry, { discard: true });
      }
      refreshCleanTabs();
      toast(`Loaded the latest ${what} from Postman`);
      emit('tabs', 'main');
      return false;
    }
  } catch (e) {
    toast(errText(e), { error: true });
  }
  return false;
}

// ---------- tree edits ----------

export function expanded() {
  const map = (state.settings.expanded = state.settings.expanded || {});
  return (map[state.ws.id] = map[state.ws.id] || []);
}

export function toggleExpanded(key, force) {
  const list = expanded();
  const i = list.indexOf(key);
  const open = force ?? i < 0;
  if (open && i < 0) list.push(key);
  if (!open && i >= 0) list.splice(i, 1);
  S.saveSettings();
  emit('sidebar');
}

export function expandPath(entry, folderId) {
  toggleExpanded(entry.uid, true);
  if (folderId) {
    const f = findItem(entry.data, folderId);
    for (const p of f?.parents || []) toggleExpanded(itemId(p), true);
    toggleExpanded(folderId, true);
  }
}

export async function addRequest(entry, folderId) {
  await S.ensureCollection(entry);
  const item = newRequestItem();
  const list = folderId ? findItem(entry.data, folderId).item.item : (entry.data.item = entry.data.item || []);
  list.push(item);
  expandPath(entry, folderId);
  await S.collectionChanged(entry, { push: false });
  openItem(entry, item.id);
  pushIfAuto(entry);
}

export async function addFolder(entry, parentId, name) {
  await S.ensureCollection(entry);
  const f = newFolder(name);
  const list = parentId ? findItem(entry.data, parentId).item.item : (entry.data.item = entry.data.item || []);
  list.push(f);
  expandPath(entry, parentId);
  toggleExpanded(f.id, true);
  await S.collectionChanged(entry, { push: false });
  pushIfAuto(entry);
}

export async function renameItem(entry, id, name) {
  await S.ensureCollection(entry);
  if (!id) entry.data.info.name = name;
  else findItem(entry.data, id).item.name = name;
  for (const t of wsTabs()) if (t.ref?.col === entry.uid && t.ref.item === id && t.draft) t.draft.name = name;
  await S.collectionChanged(entry, { push: false });
  emit('tabs', 'main');
  pushIfAuto(entry);
}

export async function duplicate(entry, id) {
  const loc = findParentList(entry.data, id);
  const copy = duplicateItem(loc.list[loc.index]);
  loc.list.splice(loc.index + 1, 0, copy);
  await S.collectionChanged(entry, { push: false });
  if (!isFolder(copy)) openItem(entry, copy.id);
  pushIfAuto(entry);
}

export async function removeItem(entry, id) {
  const loc = findParentList(entry.data, id);
  const it = loc.list[loc.index];
  const ok = await confirmDialog({ title: `Delete "${it.name}"?`, message: isFolder(it) ? 'The folder and every request inside it will be deleted, here and in Postman.' : 'This request will be deleted here and in Postman.', confirm: 'Delete', danger: true });
  if (!ok) return;
  loc.list.splice(loc.index, 1);
  const ids = new Set([id]);
  if (isFolder(it)) (function collect(items) { for (const x of items) { ids.add(x.id); if (x.item) collect(x.item); } })(it.item);
  for (const t of wsTabs()) if (t.ref?.col === entry.uid && ids.has(t.ref.item)) await closeTab(t.id, { force: true });
  await S.collectionChanged(entry, { push: false });
  pushIfAuto(entry);
}

/** Move an item before/after another item, or into a folder (same collection). */
export async function moveItem(entry, dragId, targetId, where) {
  if (dragId === targetId) return;
  const target = targetId ? findItem(entry.data, targetId) : null;
  if (target && target.parents.some((p) => p.id === dragId)) return; // can't drop into own child
  const from = findParentList(entry.data, dragId);
  if (!from) return;
  const [moved] = from.list.splice(from.index, 1);
  if (!targetId || where === 'inside') {
    const list = targetId ? target.item.item : entry.data.item;
    list.push(moved);
    if (targetId) toggleExpanded(targetId, true);
  } else {
    const to = findParentList(entry.data, targetId);
    to.list.splice(where === 'before' ? to.index : to.index + 1, 0, moved);
  }
  await S.collectionChanged(entry, { push: false });
  pushIfAuto(entry);
}

const pushTimers = new WeakMap();
function pushIfAuto(entry) {
  if (S.isCloud() && state.settings.syncMode === 'auto' && state.hasKey) {
    const ws = state.ws; // the push belongs to this workspace even if you switch before it fires
    clearTimeout(pushTimers.get(entry));
    pushTimers.set(entry, setTimeout(() => pushNow(entry, { quiet: true, ws }), 1200));
  }
}
