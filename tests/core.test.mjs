// Run with: npm test
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { parseUrl, setRawUrl, rawWithQuery, normaliseImport, forUpload, findItem, effectiveAuth, getScript, setScript, duplicateItem } from '../src/js/model.js';
import { Scope, Resolver, DYNAMIC, localOnlyKeys, persistCurrent, resetCurrent } from '../src/js/vars.js';
import { runScript } from '../src/js/scripts.js';
import { buildOutgoing, execute } from '../src/js/send.js';

const require = createRequire(import.meta.url);
const libs = {
  chai: require('../src/vendor/chai.min.js'),
  CryptoJS: require('../src/vendor/crypto-js.min.js'),
  lodash: require('../src/vendor/lodash.min.js'),
};

const scopes = (env = [], col = [], glob = []) => ({
  local: new Scope([], {}),
  environment: new Scope(env, {}),
  collection: new Scope(col, {}),
  globals: new Scope(glob, {}),
});

test('parseUrl keeps variables and splits query', () => {
  const u = parseUrl('{{baseUrl}}/users/:id?page=2&q=a#top');
  assert.deepEqual(u.host, ['{{baseUrl}}']);
  assert.deepEqual(u.path, ['users', ':id']);
  assert.deepEqual(u.query, [{ key: 'page', value: '2' }, { key: 'q', value: 'a' }]);
  assert.equal(u.hash, 'top');
  assert.deepEqual(u.variable, [{ key: 'id', value: '' }]);
  const v = parseUrl('https://api.example.com:8443/v1');
  assert.equal(v.protocol, 'https');
  assert.equal(v.port, '8443');
  assert.deepEqual(v.host, ['api', 'example', 'com']);
});

test('query with ? inside a variable is not split', () => {
  const u = parseUrl('{{host?x}}/a');
  assert.equal(u.query, undefined);
});

test('rawWithQuery and setRawUrl preserve disabled params and path var values', () => {
  assert.equal(rawWithQuery('http://x/a?old=1#h', [{ key: 'a', value: '1' }, { key: 'b', value: '2', disabled: true }]), 'http://x/a?a=1#h');
  const req = { url: { raw: 'http://x/:id', path: [':id'], variable: [{ key: 'id', value: '42' }], query: [{ key: 'off', value: '1', disabled: true }] } };
  setRawUrl(req, 'http://x/:id?on=1');
  assert.equal(req.url.variable[0].value, '42');
  assert.equal(req.url.query.length, 2);
});

test('variable precedence: local > env > collection > globals; overlay wins over initial', () => {
  const s = scopes([{ key: 'a', value: 'env', enabled: true }, { key: 'off', value: 'x', enabled: false }], [{ key: 'a', value: 'col' }, { key: 'b', value: 'col' }], [{ key: 'c', value: 'g' }]);
  const r = new Resolver(s);
  assert.equal(r.replace('{{a}}-{{b}}-{{c}}-{{off}}'), 'env-col-g-{{off}}');
  s.environment.set('a', 'current');
  assert.equal(r.replace('{{a}}'), 'current');
  assert.equal(s.environment.values[0].value, 'env', 'initial value untouched');
  s.local.set('a', 'local');
  assert.equal(r.replace('{{a}}'), 'local');
  s.environment.unset('b');
  assert.equal(r.replace('{{ b }}'), 'col');
  assert.match(r.replace('{{$guid}}'), /^[0-9a-f-]{36}$/);
  assert.deepEqual(r.unresolved('{{nope}} {{a}}'), ['nope']);
});

test('nested variables resolve', () => {
  const s = scopes([{ key: 'host', value: '{{proto}}://api' }, { key: 'proto', value: 'https' }]);
  assert.equal(new Resolver(s).replace('{{host}}/x'), 'https://api/x');
});

test('pre-request script: env set, header upsert, CryptoJS signing, url query', async () => {
  const s = scopes([{ key: 'secret', value: 'k' }]);
  const req = { method: 'POST', header: [{ key: 'X-Old', value: '1' }], url: parseUrl('http://x/a?z=1'), body: { mode: 'raw', raw: '{"a":1}' } };
  const code = `
    const sig = CryptoJS.MD5('ref;' + pm.environment.get('secret')).toString();
    pm.request.headers.upsert({ key: 'Signature', value: sig });
    pm.request.headers.upsert({ key: 'x-old', value: '2' });
    pm.environment.set('ts', 123);
    pm.request.url.query.add({ key: 'b', value: '2' });
    const h = require('crypto-js').HmacSHA256('m', 'k').toString(CryptoJS.enc.Hex);
    pm.variables.set('hmac', h);
    console.log('body', JSON.parse(pm.request.body.raw).a);
  `;
  const r = await runScript(code, { phase: 'prerequest', request: req, resolver: new Resolver(s), scopes: s, libs, send: async () => ({}) });
  assert.equal(r.error, null);
  assert.equal(req.header.find((h) => h.key === 'Signature').value, libs.CryptoJS.MD5('ref;k').toString());
  assert.equal(req.header.find((h) => h.key === 'X-Old').value, '2');
  assert.equal(s.environment.get('ts'), '123');
  assert.equal(req.url.raw, 'http://x/a?z=1&b=2');
  assert.equal(s.local.get('hmac').length, 64);
  assert.deepEqual(r.logs.map((l) => l.message), ['body 1']);
});

test('test script: pm.test, pm.expect, pm.response helpers, legacy tests', async () => {
  const s = scopes();
  const response = { status: 201, statusText: 'Created', headers: [{ key: 'Content-Type', value: 'application/json' }, { key: 'set-cookie', value: 'sid=abc; Path=/' }], bodyText: '{"data":{"id":7,"tags":["a","b"]}}', timeMs: 12, size: 30 };
  const code = `
    pm.test('status', () => pm.response.to.have.status(201));
    pm.test('success', () => pm.response.to.be.success);
    pm.test('json', () => { const j = pm.response.json(); pm.expect(j.data.id).to.eql(7); pm.expect(j.data.tags).to.include('b'); });
    pm.test('header', () => pm.response.to.have.header('content-type'));
    pm.test('fails', () => pm.expect(pm.response.code).to.equal(200));
    pm.test('async', async () => { await new Promise(r => setTimeout(r, 5)); pm.expect(1).to.be.above(2); });
    pm.test('jsonBody', () => pm.response.to.have.jsonBody('data.id', 7));
    pm.collectionVariables.set('id', pm.response.json().data.id);
    tests['legacy'] = responseCode.code === 201;
    pm.expect(pm.cookies.get('sid')).to.equal('abc');
  `;
  const r = await runScript(code, { phase: 'test', request: { url: parseUrl('http://x'), header: [] }, response, resolver: new Resolver(s), scopes: s, libs, send: async () => ({}) });
  assert.equal(r.error, null);
  const byName = Object.fromEntries(r.tests.map((t) => [t.name, t]));
  assert.equal(byName.status.passed, true);
  assert.equal(byName.success.passed, true);
  assert.equal(byName.json.passed, true);
  assert.equal(byName.header.passed, true);
  assert.equal(byName.fails.passed, false);
  assert.match(byName.fails.error, /expected 201 to equal 200/);
  assert.equal(byName.async.passed, false);
  assert.equal(byName.jsonBody.passed, true);
  assert.equal(byName.legacy.passed, true);
  assert.equal(s.collection.get('id'), '7');
});

test('script syntax/runtime errors are reported, not thrown', async () => {
  const s = scopes();
  const r = await runScript('pm.environment.get(;', { phase: 'prerequest', request: { header: [], url: parseUrl('') }, resolver: new Resolver(s), scopes: s, libs, send: async () => ({}) });
  assert.ok(r.error);
});

test('pm.sendRequest works with callback and await', async () => {
  const s = scopes([{ key: 'host', value: 'http://h' }]);
  const calls = [];
  const send = async (o) => { calls.push(o); return { status: 200, statusText: 'OK', headers: [], bodyText: '{"token":"t1"}', timeMs: 1, size: 1 }; };
  const code = `
    pm.sendRequest({ url: '{{host}}/token', method: 'POST', header: { 'X-A': '1' }, body: { mode: 'raw', raw: { a: 1 } } }, (err, res) => {
      pm.environment.set('token', res.json().token);
    });
    const r2 = await pm.sendRequest('{{host}}/two');
    pm.variables.set('two', r2.code);
  `;
  const r = await runScript(code, { phase: 'prerequest', request: { header: [], url: parseUrl('') }, resolver: new Resolver(s), scopes: s, libs, send });
  assert.equal(r.error, null);
  assert.equal(s.environment.get('token'), 't1');
  assert.equal(s.local.get('two'), '200');
  assert.equal(calls[0].url, 'http://h/token');
  assert.equal(calls[0].body.content, '{"a":1}');
  assert.deepEqual(calls[0].headers, [{ key: 'X-A', value: '1' }]);
});

const sample = {
  info: { _postman_id: 'c1', name: 'Demo', schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json', updatedAt: '2026-01-01', uid: 'u-c1' },
  auth: { type: 'bearer', bearer: [{ key: 'token', value: '{{token}}', type: 'string' }] },
  variable: [{ key: 'base', value: 'http://api.test' }],
  event: [{ listen: 'prerequest', script: { exec: ["pm.request.headers.add({key:'X-Col', value:'1'})"] } }],
  item: [{
    name: 'Users', id: 'f1', uid: 'u-f1',
    auth: { type: 'apikey', apikey: [{ key: 'key', value: 'X-Key' }, { key: 'value', value: 'abc' }, { key: 'in', value: 'header' }] },
    item: [
      { name: 'Get user', id: 'r1', uid: 'u-r1', request: { method: 'GET', header: [{ key: 'H', value: '{{hv}}' }, { key: 'Off', value: 'x', disabled: true }], url: { raw: '{{base}}/users/:id?x=1', host: ['{{base}}'], path: ['users', ':id'], query: [{ key: 'x', value: '1' }], variable: [{ key: 'id', value: '9' }] } }, response: [], customField: { keep: true } },
      { name: 'Create', id: 'r2', request: { method: 'POST', auth: { type: 'noauth' }, header: [], url: '{{base}}/users', body: { mode: 'raw', raw: '{"n":"{{name}}"}', options: { raw: { language: 'json' } } } }, event: [{ listen: 'test', script: { exec: ["pm.test('ok', () => pm.response.to.be.ok)"] } }] },
    ],
  }],
};

test('import normalises string urls, keeps unknown fields; upload strips server fields', () => {
  const { kind, data } = normaliseImport({ collection: sample });
  assert.equal(kind, 'collection');
  const r2 = findItem(data, 'r2').item;
  assert.equal(typeof r2.request.url, 'object');
  assert.deepEqual(findItem(data, 'r1').item.customField, { keep: true });
  const up = forUpload(data);
  assert.equal(up.info.updatedAt, undefined);
  assert.equal(up.info.uid, undefined);
  assert.equal(up.item[0].uid, undefined);
  assert.equal(up.item[0].item[0].id, 'r1', 'ids kept so Postman updates in place');
});

test('auth inheritance: request > folder > collection; noauth stops it', () => {
  const c = normaliseImport(sample).data;
  const f = findItem(c, 'r1');
  assert.equal(effectiveAuth(f.item.request, f.parents, c).auth.type, 'apikey');
  const g = findItem(c, 'r2');
  assert.equal(effectiveAuth(g.item.request, g.parents, c).auth.type, 'noauth');
  const noFolderAuth = { ...f.parents[0], auth: undefined };
  assert.equal(effectiveAuth(f.item.request, [noFolderAuth], c).auth.type, 'bearer');
});

test('buildOutgoing: path vars, disabled headers, auth, json content type', () => {
  const c = normaliseImport(sample).data;
  const s = scopes([{ key: 'hv', value: 'hello' }, { key: 'name', value: 'Ada' }], c.variable);
  const r = new Resolver(s);
  const f = findItem(c, 'r1');
  const o = buildOutgoing(f.item.request, effectiveAuth(f.item.request, f.parents, c).auth, r, {});
  assert.equal(o.url, 'http://api.test/users/9?x=1');
  assert.deepEqual(o.headers.find((h) => h.key === 'H'), { key: 'H', value: 'hello' });
  assert.ok(!o.headers.some((h) => h.key === 'Off'));
  assert.deepEqual(o.headers.find((h) => h.key === 'X-Key'), { key: 'X-Key', value: 'abc' });
  const g = findItem(c, 'r2');
  const o2 = buildOutgoing(g.item.request, effectiveAuth(g.item.request, g.parents, c).auth, r, {});
  assert.equal(o2.body.content, '{"n":"Ada"}');
  assert.ok(o2.headers.some((h) => h.key === 'Content-Type' && h.value === 'application/json'));
  assert.ok(!o2.headers.some((h) => h.key === 'Authorization'));
});

test('basic auth and apikey-in-query', () => {
  const r = new Resolver(scopes());
  const o = buildOutgoing({ method: 'GET', url: parseUrl('http://x/a'), header: [] }, { type: 'basic', basic: [{ key: 'username', value: 'u' }, { key: 'password', value: 'p' }] }, r, {});
  assert.equal(o.headers.find((h) => h.key === 'Authorization').value, 'Basic ' + Buffer.from('u:p').toString('base64'));
  const q = buildOutgoing({ method: 'GET', url: parseUrl('http://x/a?b=1'), header: [] }, { type: 'apikey', apikey: [{ key: 'key', value: 'k' }, { key: 'value', value: 'v' }, { key: 'in', value: 'query' }] }, r, {});
  assert.equal(q.url, 'http://x/a?b=1&k=v');
});

test('execute runs collection + request scripts in order and records tests', async () => {
  const c = normaliseImport(sample).data;
  const s = scopes([{ key: 'name', value: 'Ada' }], c.variable);
  const g = findItem(c, 'r2');
  let sent;
  const send = async (o) => { sent = o; return { status: 200, statusText: 'OK', headers: [], bodyText: '{}', timeMs: 3, size: 2 }; };
  const out = await execute({ item: g.item, parents: g.parents, collection: c, scopes: s, settings: {}, send, libs });
  assert.equal(out.error, null);
  assert.ok(sent.headers.some((h) => h.key === 'X-Col'), 'collection pre-request ran');
  assert.deepEqual(out.tests.map((t) => [t.name, t.passed]), [['ok', true]]);
});

test('scripts helpers round-trip', () => {
  const it = {};
  setScript(it, 'test', 'a\nb');
  assert.equal(getScript(it, 'test'), 'a\nb');
  setScript(it, 'test', '  ');
  assert.equal(it.event, undefined);
});

test('duplicate gives fresh ids', () => {
  const c = normaliseImport(sample).data;
  const d = duplicateItem(c.item[0]);
  assert.notEqual(d.id, 'f1');
  assert.notEqual(d.item[0].id, 'r1');
  assert.equal(d.item[0].uid, undefined);
});

import { parseCurl } from '../src/js/curl.js';

test('parseCurl handles common shapes', () => {
  const a = parseCurl(`curl --location 'https://api.x.io/v1/pay?ref=1' \\\n  -H 'Content-Type: application/json' \\\n  -H "Authorization: Bearer t0k" \\\n  --data-raw '{"amount":100,"note":"it'\\''s"}'`);
  assert.equal(a.method, 'POST');
  assert.equal(a.url.raw, 'https://api.x.io/v1/pay?ref=1');
  assert.deepEqual(a.header.map((h) => h.key), ['Content-Type', 'Authorization']);
  assert.equal(a.body.options.raw.language, 'json');
  assert.equal(JSON.parse(a.body.raw).amount, 100);
  assert.equal(JSON.parse(a.body.raw).note, "it's");

  const b = parseCurl(`curl -X PUT https://h/x -u ada:pw -d 'a=1&b=two%20words' -H 'Content-Type: application/x-www-form-urlencoded'`);
  assert.equal(b.method, 'PUT');
  assert.equal(b.auth.type, 'basic');
  assert.deepEqual(b.body.urlencoded, [{ key: 'a', value: '1' }, { key: 'b', value: 'two words' }]);

  const c = parseCurl(`curl https://h/up -F 'name=Ada' -F 'file=@/tmp/a.pdf'`);
  assert.equal(c.method, 'POST');
  assert.deepEqual(c.body.formdata[1], { key: 'file', type: 'file', src: '/tmp/a.pdf' });

  assert.throws(() => parseCurl('wget x'));
});

test('forUpload strips fields Postman rejects on collection variables', () => {
  const up = forUpload({ info: { name: 'x', schema: 's' }, item: [], variable: [{ key: 'a', value: '1', id: 'v1', description: 'd', enabled: false }, { key: '', value: 'blank' }] });
  assert.deepEqual(up.variable, [{ key: 'a', value: '1', disabled: true }]);
});

test('setRawUrl keeps param descriptions and disabled params in place', () => {
  const req = { url: { raw: 'http://x/a?a=1&c=3', query: [{ key: 'a', value: '1', description: 'first' }, { key: 'b', value: '2', disabled: true }, { key: 'c', value: '3' }] } };
  setRawUrl(req, 'http://x/a?a=9&c=3&d=4');
  assert.deepEqual(req.url.query, [
    { key: 'a', value: '9', description: 'first' },
    { key: 'b', value: '2', disabled: true },
    { key: 'c', value: '3' },
    { key: 'd', value: '4' },
  ]);
});

test('duplicate gives examples new ids', () => {
  const d = duplicateItem({ id: 'r', name: 'R', request: {}, response: [{ id: 'ex1', name: 'ok' }] });
  assert.notEqual(d.response[0].id, 'ex1');
});

test('script-created variables show up as local-only, and persist turns them into shared ones', async () => {
  const col = [{ key: 'baseUrl', value: 'https://a.test' }];
  const colOverlay = {};
  const s = { local: new Scope([], {}), environment: new Scope([], {}), collection: new Scope(col, colOverlay), globals: new Scope([], {}) };
  const r = await runScript("pm.collectionVariables.set('lastStatus', 200); pm.collectionVariables.set('baseUrl', 'https://b.test'); pm.collectionVariables.unset('gone');", { phase: 'test', request: { method: 'GET', url: 'x', header: [] }, response: { status: 200, headers: [], bodyText: '' }, resolver: new Resolver(s), scopes: s, libs });
  assert.equal(r.error, null);
  assert.deepEqual(localOnlyKeys(col, colOverlay), ['lastStatus'], 'unset (null) and existing names are not local-only');

  assert.equal(persistCurrent(col, colOverlay, 'disabled'), 2);
  assert.deepEqual(col, [{ key: 'baseUrl', value: 'https://b.test' }, { key: 'lastStatus', value: '200', type: 'default' }]);
  assert.deepEqual(colOverlay, { gone: null }, 'persisted current values are cleared; unsets are kept');
  assert.equal(persistCurrent(col, colOverlay, 'disabled'), 0);

  const env = [{ key: 'a', value: '1', enabled: false }];
  const envOverlay = { a: '1', b: '2' };
  assert.equal(persistCurrent(env, envOverlay, 'enabled'), 1, 'an unchanged value does not count');
  assert.deepEqual(env[1], { key: 'b', value: '2', type: 'default', enabled: true });
  assert.equal(env[0].enabled, false, 'persist leaves enabled state alone');
  resetCurrent(envOverlay);
  assert.deepEqual(envOverlay, {});
});

test('resolver lists names by winning scope, masks secrets, and knows Postman dynamic variables', () => {
  const s = scopes([{ key: 'token', value: 'abc', type: 'secret', enabled: true }, { key: 'a', value: 'env', enabled: true }], [{ key: 'a', value: 'col' }, { key: 'b', value: 'col' }]);
  const r = new Resolver(s);
  const named = r.names().filter((n) => n.scope !== 'dynamic');
  assert.deepEqual(named.map((n) => [n.name, n.scope]), [['token', 'environment'], ['a', 'environment'], ['b', 'collection']]);
  assert.equal(named[0].secret, true);
  assert.equal(r.replace('Bearer {{token}}'), 'Bearer abc');
  assert.equal(r.replace('Bearer {{token}}', 0, { mask: true }), 'Bearer ••••••');
  assert.ok(r.names().some((n) => n.name === '$randomCity' && n.scope === 'dynamic'));

  for (const [name, fn] of Object.entries(DYNAMIC)) {
    const v = fn();
    assert.equal(typeof v, 'string', name);
    assert.ok(v.length > 0, name);
  }
  assert.ok(Object.keys(DYNAMIC).length > 90);
  assert.match(r.replace('{{$randomIP}}'), /^\d+\.\d+\.\d+\.\d+$/);
  assert.match(r.replace('{{$randomHexColor}}'), /^#[0-9a-f]{6}$/);
});
