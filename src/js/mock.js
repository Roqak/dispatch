// Browser-only stand-in for the Rust backend, used when you open src/index.html
// directly (e.g. to work on the UI). It is never loaded inside the desktop app.

const ls = globalThis.localStorage;
const read = (k) => { try { return JSON.parse(ls.getItem(`dispatch:${k}`)); } catch { return null; } };
const write = (k, v) => ls.setItem(`dispatch:${k}`, JSON.stringify(v));

const now = '2026-10-01T09:00:00.000Z';
const demoCollection = {
  info: { _postman_id: 'demo-c1', name: 'Payments API', schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json', updatedAt: now },
  auth: { type: 'bearer', bearer: [{ key: 'token', value: '{{token}}', type: 'string' }] },
  variable: [{ key: 'baseUrl', value: 'https://httpbin.org' }],
  item: [
    {
      id: 'f-auth', name: 'Auth', item: [
        { id: 'r-login', name: 'Get token', request: { method: 'POST', auth: { type: 'noauth' }, header: [], url: { raw: '{{baseUrl}}/post', host: ['{{baseUrl}}'], path: ['post'] }, body: { mode: 'raw', raw: '{\n  "client_id": "{{clientId}}",\n  "secret": "{{clientSecret}}"\n}', options: { raw: { language: 'json' } } } }, event: [{ listen: 'test', script: { exec: ["pm.test('Status is 200', () => pm.response.to.have.status(200));", "pm.environment.set('token', pm.response.json().json.client_id);"] } }] },
      ],
    },
    {
      id: 'f-tx', name: 'Transactions', item: [
        { id: 'r-list', name: 'List transactions', request: { method: 'GET', header: [{ key: 'X-Request-Ref', value: '{{$guid}}' }], url: { raw: '{{baseUrl}}/get?page=1&limit=20', host: ['{{baseUrl}}'], path: ['get'], query: [{ key: 'page', value: '1' }, { key: 'limit', value: '20' }, { key: 'status', value: 'successful', disabled: true }] } } },
        { id: 'r-create', name: 'Create transaction', request: { method: 'POST', header: [], url: { raw: '{{baseUrl}}/anything/transactions', host: ['{{baseUrl}}'], path: ['anything', 'transactions'] }, body: { mode: 'raw', raw: '{\n  "amount": 250000,\n  "currency": "NGN",\n  "narration": "Invoice 2041"\n}', options: { raw: { language: 'json' } } } }, event: [{ listen: 'prerequest', script: { exec: ["const sig = CryptoJS.MD5(pm.environment.get('clientSecret')).toString();", "pm.request.headers.upsert({ key: 'Signature', value: sig });"] } }] },
        { id: 'r-get', name: 'Get transaction', request: { method: 'GET', header: [], url: { raw: '{{baseUrl}}/anything/transactions/:id', host: ['{{baseUrl}}'], path: ['anything', 'transactions', ':id'], variable: [{ key: 'id', value: 'TX-1001' }] } } },
        { id: 'r-del', name: 'Cancel transaction', request: { method: 'DELETE', header: [], url: { raw: '{{baseUrl}}/delete', host: ['{{baseUrl}}'], path: ['delete'] } } },
      ],
    },
    { id: 'r-health', name: 'Health check', request: { method: 'GET', auth: { type: 'noauth' }, header: [], url: { raw: '{{baseUrl}}/status/200', host: ['{{baseUrl}}'], path: ['status', '200'] } } },
  ],
};

const mockCloud = {
  '/me': { user: { id: 1, username: 'demo', fullName: 'Demo User', email: 'demo@example.com' } },
  '/workspaces': { workspaces: [{ id: 'ws1', name: 'Team Workspace', type: 'team' }, { id: 'ws2', name: 'My Workspace', type: 'personal' }] },
  '/collections?workspace=ws1': { collections: [{ uid: '1-demo-c1', id: 'demo-c1', name: 'Payments API', updatedAt: now }] },
  '/collections?workspace=ws2': { collections: [] },
  '/collections/1-demo-c1': { collection: demoCollection },
  '/environments?workspace=ws1': { environments: [{ uid: '1-env1', id: 'env1', name: 'Sandbox', updatedAt: now }, { uid: '1-env2', id: 'env2', name: 'Production', updatedAt: now }] },
  '/environments?workspace=ws2': { environments: [] },
  '/environments/1-env1': { environment: { id: 'env1', name: 'Sandbox', values: [{ key: 'clientId', value: 'sandbox-client', enabled: true }, { key: 'clientSecret', value: 's3cr3t', enabled: true, type: 'secret' }, { key: 'token', value: '', enabled: true }] } },
  '/environments/1-env2': { environment: { id: 'env2', name: 'Production', values: [{ key: 'clientId', value: 'live-client', enabled: true }] } },
  '/workspaces/ws1/global-variables': { values: [] },
  '/workspaces/ws2/global-variables': { values: [] },
};

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

// Active profile for cloud calls; the store syncs it in browser mode too.
export const mockCtx = { profileId: null, region: 'us' };
const keyName = () => `apikey:${mockCtx.profileId ?? 'local'}`;

export const mockBridge = {
  async send(req) {
    await delay(350);
    const started = performance.now();
    try {
      const init = { method: req.method, headers: Object.fromEntries(req.headers.map((h) => [h.key, h.value])) };
      if (req.body?.mode === 'raw') init.body = req.body.content;
      const res = await fetch(req.url, init);
      const text = await res.text();
      return { status: res.status, statusText: res.statusText, headers: [...res.headers].map(([key, value]) => ({ key, value })), url: res.url, contentType: res.headers.get('content-type') || '', bodyText: text, bodyBase64: null, size: text.length, timeMs: Math.round(performance.now() - started) };
    } catch {
      const body = JSON.stringify({ args: {}, headers: Object.fromEntries(req.headers.map((h) => [h.key, h.value])), method: req.method, url: req.url, json: req.body?.content ? safeJson(req.body.content) : null, note: 'Mock response (browser preview)' }, null, 2);
      return { status: 200, statusText: 'OK', headers: [{ key: 'content-type', value: 'application/json' }, { key: 'x-mock', value: 'true' }], url: req.url, contentType: 'application/json', bodyText: body, bodyBase64: null, size: body.length, timeMs: 142 };
    }
  },
  async clearCookies() {},
  async postman(method, path, body) {
    await delay(200);
    if (!read(keyName())) throw 'This profile has no Postman API key. Add it under Settings → Profiles.';
    // A tiny fake Postman that remembers writes, so sync flows can be exercised.
    const cloud = read('mockcloud') || JSON.parse(JSON.stringify(mockCloud));
    const save = () => write('mockcloud', cloud);
    const stamp = () => new Date(Date.now() + Math.floor(Math.random() * 1000)).toISOString();
    const out = (v) => JSON.parse(JSON.stringify({ ...v, _rateLimitRemainingMonth: '9874' }));
    const [p, qs] = path.split('?');
    const ws = new URLSearchParams(qs || '').get('workspace');
    let m;
    if (method === 'GET') {
      const hit = cloud[path];
      if (!hit) throw `Postman returned 404: not found (${path})`;
      return out(hit);
    }
    if (method === 'PUT' && (m = p.match(/^\/collections\/(.+)$/))) {
      const uid = m[1];
      const updatedAt = stamp();
      cloud[`/collections/${uid}`] = { collection: { ...body.collection, info: { ...body.collection.info, updatedAt } } };
      for (const k of Object.keys(cloud)) if (k.startsWith('/collections?')) cloud[k].collections.forEach((c) => { if (c.uid === uid) { c.updatedAt = updatedAt; c.name = body.collection.info.name; } });
      save();
      return out({ collection: { uid, id: uid, name: body.collection.info.name } });
    }
    if (method === 'POST' && p === '/collections') {
      const id = `c-${Date.now()}`;
      const uid = `1-${id}`;
      const updatedAt = stamp();
      cloud[`/collections/${uid}`] = { collection: { ...body.collection, info: { ...body.collection.info, updatedAt } } };
      (cloud[`/collections?workspace=${ws}`] ||= { collections: [] }).collections.push({ uid, id, name: body.collection.info.name, updatedAt });
      save();
      return out({ collection: { uid, id, name: body.collection.info.name } });
    }
    if (method === 'PUT' && (m = p.match(/^\/environments\/(.+)$/))) {
      const uid = m[1];
      const updatedAt = stamp();
      cloud[`/environments/${uid}`] = { environment: { id: uid, ...body.environment } };
      for (const k of Object.keys(cloud)) if (k.startsWith('/environments?')) cloud[k].environments.forEach((e) => { if (e.uid === uid) { e.updatedAt = updatedAt; e.name = body.environment.name; } });
      save();
      return out({ environment: { uid, id: uid, name: body.environment.name } });
    }
    if (method === 'POST' && p === '/environments') {
      const uid = `1-e${Date.now()}`;
      cloud[`/environments/${uid}`] = { environment: { id: uid, ...body.environment } };
      (cloud[`/environments?workspace=${ws}`] ||= { environments: [] }).environments.push({ uid, id: uid, name: body.environment.name, updatedAt: stamp() });
      save();
      return out({ environment: { uid, id: uid, name: body.environment.name } });
    }
    if (method === 'PUT' && /global-variables$/.test(p)) { cloud[p] = { values: body.values }; save(); return out({ values: body.values }); }
    throw `Mock doesn't handle ${method} ${path}`;
  },
  /** Test hook: simulate a teammate editing a collection in Postman. */
  async _remoteEdit(uid, mutate) {
    const cloud = read('mockcloud');
    const c = cloud[`/collections/${uid}`].collection;
    mutate(c);
    const updatedAt = new Date(Date.now() + 5000).toISOString();
    c.info.updatedAt = updatedAt;
    for (const k of Object.keys(cloud)) if (k.startsWith('/collections?')) cloud[k].collections.forEach((x) => { if (x.uid === uid) x.updatedAt = updatedAt; });
    write('mockcloud', cloud);
  },
  async setApiKey(key, profileId, region) { await delay(300); if (!key.startsWith('PMAK-')) throw 'Postman rejected the API key.'; mockCtx.profileId = profileId; mockCtx.region = region || 'us'; write(`apikey:${profileId}`, key); return mockCloud['/me']; },
  async hasApiKey(profileId) { return !!read(`apikey:${profileId}`); },
  async deleteApiKey(profileId) { ls.removeItem(`dispatch:apikey:${profileId}`); },
  async hasLegacyKey() { return !!read('apikey'); },
  async migrateLegacyKey(profileId) { const k = read('apikey'); if (!k) return false; write(`apikey:${profileId}`, k); return true; },
  async read(name) { return read(name); },
  async write(name, value) { write(name, value); },
  async openTextFile() { return null; },
  async pickFilePath() { return '/Users/demo/Desktop/receipt.pdf'; },
  async saveTextFile() { return null; },
  async saveBinaryFile() { return null; },
};

function safeJson(s) { try { return JSON.parse(s); } catch { return s; } }
