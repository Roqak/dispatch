// The collection runner: batch requests through the normal send pipeline,
// against optional data rows, with a results matrix and run history.

import { clone, findItem, isFolder, itemId } from './model.js';
import { Scope } from './vars.js';
import { execute } from './send.js';
import { bridge } from './bridge.js';
import * as S from './store.js';
import { state } from './store.js';

export const HISTORY_STORE = 'runner-history';

/** Requests under a collection root or folder, depth-first in display order. */
export function flattenRequests(root, folderId = null) {
  const found = folderId ? findItem(root, folderId) : null;
  // findItem returns the matched node; a folder's children are one level down.
  // The folder stays in `parents` so its scripts run for everything inside.
  const start = found ? (found.item?.item || []) : (root?.item || []);
  const seedParents = found ? [found.item] : [];
  const out = [];
  const walk = (items, parents) => {
    for (const it of items || []) {
      if (isFolder(it)) walk(it.item, [...parents, it]);
      else if (it.request) out.push({ item: it, parents });
    }
  };
  walk(start, seedParents);
  return out;
}

/** Accept a JSON array of objects, or CSV (first row = headers). Returns rows or null. */
export function parseDataFile(text) {
  const trimmed = (text || '').trim();
  if (!trimmed) return [];
  try {
    const json = JSON.parse(trimmed);
    if (Array.isArray(json) && json.every((x) => x && typeof x === 'object')) return json.map((x) => Object.fromEntries(Object.entries(x).map(([k, v]) => [k, v == null ? '' : String(v)])));
  } catch { /* fall through to CSV */ }
  const lines = trimmed.split(/\r?\n/).filter((l) => l.trim());
  if (lines.length < 2) return null;
  const split = (line) => {
    const fields = []; let cur = ''; let q = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (q) { if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; } else if (c === '"') q = false; else cur += c; }
      else if (c === '"') q = true;
      else if (c === ',') { fields.push(cur); cur = ''; }
      else cur += c;
    }
    fields.push(cur);
    return fields;
  };
  const headers = split(lines[0]);
  const rows = [];
  for (const line of lines.slice(1)) {
    const cells = split(line);
    rows.push(Object.fromEntries(headers.map((hd, i) => [hd, cells[i] ?? ''])));
  }
  return rows;
}

const runnerScopes = ({ ws, env, collection, row, iteration }) => ({
  local: new Scope([], {}),
  data: row ? new Scope(Object.entries(row).map(([k, v]) => ({ key: k, value: String(v), enabled: true })), {}, null, `Data · iteration ${iteration}`) : undefined,
  environment: new Scope(env?.data?.values || [], env?.overlay || {}, null, env?.name),
  collection: new Scope(collection?.variable || [], {}, null, collection?.info?.name),
  globals: new Scope(ws.globals.values || [], ws.globals.overlay || {}, null, 'Globals'),
});

/**
 * Run every request of a collection or folder. `iterations` applies when
 * there are no data rows; with rows, one iteration runs per row.
 * opts: { entry, folderId, iterations, rows, delayMs, onProgress, isStopped,
 *         env, send, parallel, saveExamples ('none' | 'failed') }
 * Cancellation: throws nothing — returns a cancelled summary.
 */
export async function runBatch({ entry, folderId = null, iterations = 1, rows = [], delayMs = 0, onProgress, isStopped, env, send, parallel = false, saveExamples = 'none' }) {
  await S.ensureCollection(entry);
  const collection = entry.data;
  const ws = state.ws || { globals: { values: [], overlay: {}, dirty: false }, colOverlays: {} };
  env = env === null ? null : (env ?? S.activeEnvEntry());
  if (env && !env.data) { try { await S.pullEnvironment(env); } catch { /* fall back to values */ } if (env && !env.data) env = null; }
  const reqs = flattenRequests(collection, folderId);
  if (!reqs.length) throw new Error('Nothing to run: this collection or folder has no requests.');

  const total = Math.max(1, rows.length || iterations);
  const allResults = [];
  const examplePlan = [];
  const started = Date.now();
  let stopped = false;
  let completedIterations = 0;

  const runOne = async (i, j, item, parents) => {
    const row = rows.length ? rows[i] : null;
    // Parallel iterations share nothing: overlays are cloned so scripts that
    // write current values never race.
    const cloneOverlays = parallel && i > 0;
    const scopeSet = runnerScopes({
      ws: cloneOverlays ? ({ ...ws, globals: { ...ws.globals, overlay: { ...(ws.globals.overlay || {}) } }, colOverlays: { ...(ws.colOverlays || {}) } }) : ws,
      env: cloneOverlays && env ? { ...env, overlay: { ...(env.overlay || {}) } } : env,
      collection, row, iteration: i + 1,
    });
    let result;
    try {
      result = await execute({
        item, parents, collection,
        scopes: scopeSet,
        settings: state.settings,
        send: send ?? ((r) => bridge.send(r)),
        libs: globalThis.chai ? { chai: globalThis.chai, CryptoJS: globalThis.CryptoJS, lodash: globalThis._ } : undefined,
      });
    } catch (e) {
      result = { error: String(e?.message || e), tests: [], logs: [], notes: [], scriptErrors: [] };
    }
    S.addHistory({
      name: item.name, method: item.request?.method || 'GET',
      url: result.outgoing?.url || '', status: result.response?.status ?? null,
      timeMs: result.response?.timeMs ?? null, error: result.error || null,
    });
    const res = {
      id: itemId(item), iteration: i + 1,
      name: item.name, method: item.request?.method || 'GET',
      status: result.response?.status ?? null,
      timeMs: result.response?.timeMs ?? null,
      testsTotal: result.tests?.length ?? 0,
      testsPassed: (result.tests || []).filter((x) => x.passed).length,
      failures: (result.tests || []).filter((x) => x.passed === false).map((x) => x.name),
      error: result.error ?? null,
      notes: result.notes ?? [],
    };
    if (saveExamples === 'failed' && result.response && (res.status == null || res.status >= 400 || (result.tests || []).some((x) => x.passed === false))) {
      examplePlan.push({ item, response: result.response, result: res });
      res.exampleSaved = false; // set true once applied
    }
    onProgress?.(res);
    if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
    return res;
  };

  if (parallel) {
    const tasks = [];
    for (let i = 0; i < total; i++) {
      for (let j = 0; j < reqs.length; j++) {
        if (isStopped?.()) { stopped = true; break; }
        tasks.push(runOne(i, j, reqs[j].item, reqs[j].parents).then((res) => { allResults.push(res); }));
      }
      if (stopped) break;
    }
    await Promise.all(tasks);
    completedIterations = stopped ? allResults.filter((r, idx, a2) => a2.findIndex((x) => x.iteration === r.iteration) === idx).length : total;
    allResults.sort((a2, b2) => a2.iteration - b2.iteration);
  } else {
    for (let i = 0; i < total; i++) {
      const row = rows.length ? rows[i] : null;
      void row;
      const iterationResults = [];
      for (let j = 0; j < reqs.length; j++) {
        if (isStopped?.()) { stopped = true; break; }
        const res = await runOne(i, j, reqs[j].item, reqs[j].parents);
        iterationResults.push(res);
      }
      if (stopped) break;
      allResults.push(...iterationResults);
      completedIterations = i + 1;
    }
  }

  // Apply saved examples into the collection, then push.
  if (saveExamples === 'failed' && examplePlan.length) {
    for (const { item, response, result } of examplePlan) {
      item.response = item.response || [];
      item.response.push({
        name: `Runner ${result.iteration}: ${response.status} ${response.statusText || ''}`.trim(),
        originalRequest: clone(item.request),
        status: response.statusText,
        code: response.status,
        _postman_previewlanguage: (response.contentType || '').includes('json') ? 'json' : 'text',
        header: (response.headers || []).map((x) => ({ key: x.key, value: x.value })),
        cookie: [],
        body: (response.bodyText || '').slice(0, 100_000),
      });
      result.exampleSaved = true;
    }
    await S.collectionChanged(entry, { push: true }).catch(() => { entry.dirty = true; S.saveWorkspace(); });
  }

  const passed = allResults.filter((r) => !r.error && r.status && r.status < 400 && r.testsPassed === r.testsTotal).length;
  const failed = allResults.length - passed;
  return {
    at: started, collectionUid: entry.uid, collectionName: folderId ? findItem(collection, folderId)?.name || collection?.info?.name : collection?.info?.name,
    folderId: folderId || null, durationMs: Date.now() - started, iterations: completedIterations,
    requestsPerIteration: reqs.length, results: allResults, passed, failed, cancelled: stopped,
  };
}

export async function saveRunSummary(run) {
  const history = (await bridge.read(HISTORY_STORE)) || [];
  const summary = {
    at: run.at, name: run.collectionName, durationMs: run.durationMs,
    iterations: run.iterations, requests: run.requestsPerIteration,
    passed: run.passed, failed: run.failed, cancelled: run.cancelled || false,
  };
  await bridge.write(HISTORY_STORE, [summary, ...history].slice(0, 20));
}

export const loadRunHistory = async () => (await bridge.read(HISTORY_STORE)) || [];