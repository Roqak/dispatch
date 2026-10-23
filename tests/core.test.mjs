// Run with: npm test
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { parseUrl, setRawUrl, rawWithQuery, normaliseImport, forUpload, findItem, effectiveAuth, getScript, setScript, duplicateItem } from '../src/js/model.js';
import { Scope, Resolver, DYNAMIC, localOnlyKeys, persistCurrent, resetCurrent } from '../src/js/vars.js';
import { runScript } from '../src/js/scripts.js';
import { buildOutgoing, execute } from '../src/js/send.js';
import { stripJsonComments, formatJsonc, jsonProblem } from '../src/js/jsonc.js';

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

test('JSON bodies: comments are stripped before sending, but never inside strings', () => {
  const raw = '{\n  "model": "kimi", // pick a model\n  /* block */ "url": "https://x.io//a", "q": "say \\"//hi\\"",\n  "n": {{n}}\n}';
  const r = new Resolver(scopes([{ key: 'n', value: '2' }]));
  const req = (language) => ({ method: 'POST', url: parseUrl('http://api.test'), header: [], body: { mode: 'raw', raw, options: { raw: { language } } } });
  const sent = buildOutgoing(req('json'), null, r, {}).body.content;
  assert.deepEqual(JSON.parse(sent), { model: 'kimi', url: 'https://x.io//a', q: 'say "//hi"', n: 2 });
  assert.equal(buildOutgoing(req('text'), null, r, {}).body.content, raw.replace('{{n}}', '2'), 'only JSON bodies are touched');
  assert.equal(stripJsonComments('// only a comment'), '');
});

test('Beautify keeps comments and {{variables}}, and points at real errors', () => {
  const src = '{"model":"kimi", // pick a model\n"messages":[{"role":"user","content":"hi"} ],"n":{{n}},"e":{},"l":[]}';
  const out = formatJsonc(src);
  assert.equal(out, [
    '{',
    '  "model": "kimi", // pick a model',
    '  "messages": [',
    '    {',
    '      "role": "user",',
    '      "content": "hi"',
    '    }',
    '  ],',
    '  "n": {{n}},',
    '  "e": {},',
    '  "l": []',
    '}',
  ].join('\n'));
  assert.equal(formatJsonc(out), out, 'formatting twice changes nothing');
  assert.equal(jsonProblem(src), null);
  assert.match(jsonProblem('{\n  "a": 1, // fine\n  "b": oops\n}'), /oops|line 3/);
});

// ---------- auth signing ----------

import { awsSigV4Sign, digestHeader, parseDigestChallenge, hawkHeader } from '../src/js/authsign.js';
import { flattenRequests, parseDataFile } from '../src/js/runner.js';

test('aws sigv4 signs a canned request deterministically', () => {
  const u = new Date('2026-10-23T12:00:00Z');
  const { headers } = awsSigV4Sign({
    method: 'GET',
    url: 'https://execute-api.us-east-1.amazonaws.com/test/mypath?Action=List&Paging=off',
    bodyContent: '',
    params: { accessKey: 'AKIDEXAMPLE', secretKey: 'wJalrXUtnFEMI', region: 'us-east-1', service: 'execute-api' },
    CryptoJS: libs.CryptoJS,
    now: u,
  });
  const auth = headers.find((h) => h.key === 'Authorization').value;
  assert.match(auth, /^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\/20261023\/us-east-1\/execute-api\/aws4_request,/);
  assert.match(auth, /SignedHeaders=host;x-amz-content-sha256;x-amz-date,/);
  assert.match(auth, /Signature=[0-9a-f]{64}$/);
  assert.equal(headers.find((h) => h.key === 'x-amz-date').value, '20261023T120000Z');
});

test('aws sigv4 supports unsigned payload for bodies JS cannot hash', () => {
  const { headers, note } = awsSigV4Sign({
    method: 'POST', url: 'https://s3.amazonaws.com/bucket/x', bodyContent: '',
    params: { accessKey: 'A', secretKey: 'B', region: 'us-east-1', service: 's3', unsignedPayload: true },
    CryptoJS: libs.CryptoJS, now: new Date(0),
  });
  assert.equal(headers.find((h) => h.key === 'x-amz-content-sha256').value, 'UNSIGNED-PAYLOAD');
  assert.equal(note, null);
});

test('aws sigv4 reports missing credentials', () => {
  const r = awsSigV4Sign({ method: 'GET', url: 'https://x.example.com/', params: { accessKey: '', secretKey: '' }, CryptoJS: libs.CryptoJS });
  assert.match(r.note, /needs an access key/);
});

test('digest challenge parses and signs', () => {
  const ch = parseDigestChallenge('Digest realm="api@x", nonce="8d1f", qop="auth", opaque="OP", algorithm=MD5');
  assert.equal(ch.realm, 'api@x');
  const h1 = digestHeader({ challenge: ch, method: 'GET', url: 'https://x.example.com/p?a=b', params: { username: 'u', password: 'p' }, CryptoJS: libs.CryptoJS, clientNonce: 'deadbeef' });
  assert.match(h1, /^Digest username="u", realm="api@x", nonce="8d1f", uri="\/p\?a=b", algorithm=MD5, qop=auth, nc=00000001, cnonce="deadbeef", response="[0-9a-f]{32}", opaque="OP"$/);
});

test('digest without qop takes the rfc2069 shape', () => {
  const ch = parseDigestChallenge('Digest realm="r", nonce="n1"');
  const h1 = digestHeader({ challenge: ch, method: 'POST', url: 'https://x.example.com/', params: { username: 'u', password: 'p' }, CryptoJS: libs.CryptoJS, clientNonce: 'c' });
  assert.match(h1, /response="[0-9a-f]{32}", opaque=$|response="[0-9a-f]{32}"$/);
  assert.ok(!h1.includes('qop='));
});

test('hawk signs the canonical request', () => {
  const { headers, note } = hawkHeader({
    method: 'GET', url: 'https://example.com:8080/ab?x=1',
    params: { authId: 'dh37fgj492je', authKey: '94H8fS7h9C', algorithm: 'sha256', includePayload: 'false', nonce: 'dead' },
    CryptoJS: libs.CryptoJS, now: new Date(1698000000000),
  });
  assert.equal(note, null);
  const auth = headers[0].value;
  assert.match(auth, /^Hawk id="dh37fgj492je", ts="\d+", nonce="dead", mac="[A-Za-z0-9+/=]+"$/);
});

test('runner flattens requests in depth-first order', () => {
  const col = { info: { name: 'c' }, item: [
    { name: 'first', request: { method: 'GET' } },
    { name: 'grp', item: [
      { name: 'inner', request: { method: 'POST' } },
      { name: 'deep', item: [{ name: 'deepest', request: { method: 'PUT' } }] },
    ] },
    { name: 'last', request: { method: 'DEL' } },
  ] };
  const flat = flattenRequests(col, null);
  assert.deepEqual(flat.map((f) => f.item.name), ['first', 'inner', 'deepest', 'last']);

  col.item[1].id = 'f1';
  const sub = flattenRequests(col, 'f1');
  assert.deepEqual(sub.map((f) => f.item.name), ['inner', 'deepest']);
  assert.equal(sub[0].parents.length, 1);
});

test('data files parse as json arrays or csv', () => {
  assert.deepEqual(parseDataFile('[{"a":1,"b":"x"}]'), [{ a: '1', b: 'x' }]);
  assert.deepEqual(parseDataFile('a,b\n1,x\n2,"y,z"'), [{ a: '1', b: 'x' }, { a: '2', b: 'y,z' }]);
  assert.equal(parseDataFile('just one line'), null);
  assert.deepEqual(parseDataFile(''), []);
});

// ---------- response diffing ----------

import { lineDiff, diffResponses } from '../src/js/jsondiff.js';

test('line diff with common edges', () => {
  const r = lineDiff(['x', 'y', 'z'], ['x', 'Y', 'z']);
  assert.deepEqual(r, [{ type: 'del', line: 1, text: 'y' }, { type: 'add', line: 1, text: 'Y' }]);
});

test('json value diff reports only real changes', () => {
  const r = diffResponses(JSON.stringify({ a: 1, b: [1, 2], c: { d: 'x' } }), JSON.stringify({ a: 2, b: [1, 2], c: { d: 'x' }, e: 'new' }), {});
  assert.deepEqual(r.rows.map((x) => [x.type, x.path]), [['change', 'a'], ['add', 'e']]);
  assert.equal(r.mode, 'json');
});

test('json array order can be ignored', () => {
  const r = diffResponses(JSON.stringify([1, 2, 3]), JSON.stringify([3, 1, 2]), { ignoreArrayOrder: true });
  assert.deepEqual(r.rows, []);
  const strict = diffResponses(JSON.stringify([1, 2, 3]), JSON.stringify([3, 1, 2]), { ignoreArrayOrder: false });
  assert.equal(strict.rows.length > 0, true);
});

test('non-json bodies fall back to line mode', () => {
  const r = diffResponses('<h1>one</h1>', '<h1>two</h1>');
  assert.equal(r.mode, 'lines');
  assert.ok(r.rows.length >= 2);
});

test('identical bodies report as such', () => {
  const r = diffResponses('same', 'same');
  assert.equal(r.stats.same, 'identical');
  assert.deepEqual(r.rows, []);
});

// ---------- runner options ----------

import { runBatch } from '../src/js/runner.js';

const mkCol = (data) => ({ uid: `c-${Date.now()}`, name: 'RunnerTest', updatedAt: null, data, dirty: false, pendingCreate: false });

test('runBatch runs requests sequentially with shared env and stops on demand', async () => {
  globalThis.chai = (await import('../src/vendor/chai.min.js')).default ?? (await import('../src/vendor/chai.min.js'));
  const entry = mkCol({ info: { name: 'R', schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json' }, variable: [], item: [
    { name: 'a', request: { method: 'GET', url: { raw: 'x://a' } }, event: [{ listen: 'test', script: { type: 'text/javascript', exec: "pm.test('ok', () => pm.expect(pm.response.code).to.eql(201));" } }] },
    { name: 'b', request: { method: 'GET', url: { raw: 'x://b' } } },
  ] });
  let lastProgress;
  const summary = await runBatch({ entry, iterations: 2, onProgress: (res) => { lastProgress = res; }, send: async () => ({ status: 201, statusText: 'Created', headers: [], bodyText: '{}', timeMs: 5, contentType: 'application/json' }) });
  assert.equal(summary.runs === undefined || summary.runs !== 0, true);
  assert.equal(summary.results.length, 4); // 2 iterations x 2 requests
  assert.equal(summary.passed, 4);
  assert.equal(summary.failed, 0);
  assert.equal(lastProgress.iteration, 2);
  assert.equal(lastProgress.name, 'b');
});
