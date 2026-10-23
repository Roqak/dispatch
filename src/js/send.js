// The request pipeline: pre-request scripts → variables → auth → send → tests.

import { clone, urlObject, getScript, effectiveAuth, authParam } from './model.js';
import { Resolver } from './vars.js';
import { runScript } from './scripts.js';

const RAW_TYPES = {
  json: 'application/json',
  xml: 'application/xml',
  html: 'text/html',
  javascript: 'application/javascript',
  text: 'text/plain',
};

const b64 = (s) => btoa(unescape(encodeURIComponent(s)));

/** Turn a (script-modified, unresolved) Postman request into what the backend sends. */
export function buildOutgoing(req, auth, resolver, settings) {
  const R = (s) => resolver.replace(s == null ? '' : String(s));
  const u = urlObject(req.url);

  // Path variables (:id) take values from the url.variable table.
  let url = u.raw || '';
  for (const v of u.variable || []) {
    if (!v.key || v.disabled) continue;
    url = url.replace(new RegExp(`/:${escapeRe(v.key)}(?=/|\\?|#|$)`, 'g'), `/${encodeURIComponent(R(v.value ?? ''))}`);
  }
  url = R(url);

  const headers = (req.header || []).filter((h) => !h.disabled && h.key).map((h) => ({ key: R(h.key), value: R(h.value) }));
  const hasHeader = (k) => headers.some((h) => h.key.toLowerCase() === k.toLowerCase());
  const queryAdd = [];

  // Auth
  const applied = applyAuth(auth, R);
  for (const h of applied.headers) if (!hasHeader(h.key)) headers.push(h);
  queryAdd.push(...applied.query);
  if (queryAdd.length) {
    const qs = queryAdd.map((q) => `${encodeURIComponent(q.key)}=${encodeURIComponent(q.value)}`).join('&');
    url += (url.includes('?') ? '&' : '?') + qs;
  }

  // Body
  let body = { mode: 'none' };
  const b = req.body;
  const method = (req.method || 'GET').toUpperCase();
  const bodyDisabled = b?.disabled;
  if (b && !bodyDisabled) {
    if (b.mode === 'raw' && b.raw != null && b.raw !== '') {
      body = { mode: 'raw', content: R(b.raw) };
      const lang = b.options?.raw?.language || 'text';
      if (!hasHeader('content-type')) headers.push({ key: 'Content-Type', value: RAW_TYPES[lang] || 'text/plain' });
    } else if (b.mode === 'urlencoded') {
      body = { mode: 'urlencoded', fields: (b.urlencoded || []).filter((f) => !f.disabled && f.key).map((f) => ({ key: R(f.key), value: R(f.value) })) };
    } else if (b.mode === 'formdata') {
      body = {
        mode: 'formdata',
        fields: (b.formdata || []).filter((f) => !f.disabled && f.key).map((f) => ({
          key: R(f.key),
          kind: f.type === 'file' ? 'file' : 'text',
          value: R(f.value),
          src: Array.isArray(f.src) ? f.src[0] : f.src || null,
        })),
      };
    } else if (b.mode === 'graphql') {
      let variables;
      try { variables = b.graphql?.variables ? JSON.parse(R(b.graphql.variables)) : undefined; } catch { variables = undefined; }
      body = { mode: 'raw', content: JSON.stringify({ query: R(b.graphql?.query || ''), ...(variables ? { variables } : {}) }) };
      if (!hasHeader('content-type')) headers.push({ key: 'Content-Type', value: 'application/json' });
    } else if (b.mode === 'file' && b.file?.src) {
      body = { mode: 'file', path: b.file.src };
    }
  }
  if (!hasHeader('accept')) headers.push({ key: 'Accept', value: '*/*' });

  const ppb = req._protocolProfileBehavior || {};
  return {
    method,
    url,
    headers,
    body,
    settings: {
      timeoutMs: settings.timeoutMs ?? 30000,
      followRedirects: ppb.followRedirects ?? settings.followRedirects ?? true,
      verifySsl: ppb.strictSSL ?? settings.verifySsl ?? true,
    },
  };
}

function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

export function applyAuth(auth, R) {
  const out = { headers: [], query: [], note: null };
  if (!auth || auth.type === 'noauth' || auth.type === 'inherit') return out;
  const p = (k) => R(authParam(auth, k) ?? '');
  switch (auth.type) {
    case 'bearer': {
      const t = p('token');
      if (t) out.headers.push({ key: 'Authorization', value: `Bearer ${t}` });
      break;
    }
    case 'basic':
      out.headers.push({ key: 'Authorization', value: `Basic ${b64(`${p('username')}:${p('password')}`)}` });
      break;
    case 'apikey': {
      const key = p('key') || '';
      if (!key) break;
      if ((authParam(auth, 'in') || 'header') === 'query') out.query.push({ key, value: p('value') });
      else out.headers.push({ key, value: p('value') });
      break;
    }
    case 'oauth2': {
      const token = p('accessToken');
      if (!token) { out.note = 'OAuth 2.0 has no access token yet. Use "Get new access token".'; break; }
      if ((authParam(auth, 'addTokenTo') || 'header') === 'queryParams') out.query.push({ key: 'access_token', value: token });
      else out.headers.push({ key: 'Authorization', value: `${p('headerPrefix') || 'Bearer'} ${token}`.trim() });
      break;
    }
    default:
      out.note = `"${auth.type}" auth isn't supported in Dispatch yet, so this request was sent without it.`;
  }
  return out;
}

/**
 * Fetch an OAuth 2.0 token (client credentials or password grant).
 * Returns the parsed token response.
 */
export async function fetchOAuthToken(auth, resolver, send, settings) {
  const R = (s) => resolver.replace(s == null ? '' : String(s));
  const p = (k) => R(authParam(auth, k) ?? '');
  const grant = authParam(auth, 'grant_type') || 'client_credentials';
  const tokenUrl = p('accessTokenUrl');
  if (!tokenUrl) throw new Error('Add the Access Token URL first.');
  const fields = [{ key: 'grant_type', value: grant === 'password_credentials' ? 'password' : grant }];
  if (grant === 'password_credentials') {
    fields.push({ key: 'username', value: p('username') }, { key: 'password', value: p('password') });
  }
  if (p('scope')) fields.push({ key: 'scope', value: p('scope') });
  const headers = [{ key: 'Accept', value: 'application/json' }];
  const clientAuth = authParam(auth, 'client_authentication') || 'header';
  if (clientAuth === 'body') {
    fields.push({ key: 'client_id', value: p('clientId') }, { key: 'client_secret', value: p('clientSecret') });
  } else {
    headers.push({ key: 'Authorization', value: `Basic ${b64(`${p('clientId')}:${p('clientSecret')}`)}` });
  }
  const res = await send({ method: 'POST', url: tokenUrl, headers, body: { mode: 'urlencoded', fields }, settings });
  let json;
  try { json = JSON.parse(res.bodyText || ''); } catch { json = null; }
  if (res.status >= 400 || !json?.access_token) {
    const why = json?.error_description || json?.error || (res.bodyText || '').slice(0, 200);
    throw new Error(`The token endpoint returned ${res.status}${why ? `: ${why}` : ''}`);
  }
  return json;
}

/**
 * Run a request end to end.
 * opts: { item, parents, collection, scopes, settings, send, libs }
 */
export async function execute({ item, parents, collection, scopes, settings, send, libs }) {
  const req = clone(item.request);
  if (item.protocolProfileBehavior) req._protocolProfileBehavior = item.protocolProfileBehavior;
  const resolver = new Resolver(scopes);
  const info = { requestName: item.name, requestId: item.id };
  const out = { logs: [], tests: [], response: null, error: null, outgoing: null, notes: [], scriptErrors: [] };
  const chain = [collection, ...parents, item].filter(Boolean);

  const ctxBase = { resolver, scopes, libs, info, send };

  for (const target of chain) {
    const code = getScript(target, 'prerequest');
    if (!code) continue;
    const r = await runScript(code, { ...ctxBase, phase: 'prerequest', request: req });
    out.logs.push(...r.logs);
    if (r.error) {
      out.scriptErrors.push({ phase: 'Pre-request script', where: target === collection ? 'collection' : target.name, message: r.error });
      out.error = `Pre-request script error in ${target === collection ? 'the collection' : `"${target.name}"`}: ${r.error}`;
      return out;
    }
    if (r.skipRequest) { out.notes.push('A pre-request script skipped this request.'); return out; }
  }

  const { auth } = effectiveAuth(req, parents, collection);
  const outgoing = buildOutgoing(req, auth, resolver, settings);
  const authNote = applyAuth(auth, (s) => resolver.replace(s)).note;
  if (authNote) out.notes.push(authNote);
  const missing = new Set([...resolver.unresolved(urlObject(req.url).raw), ...(req.header || []).filter((h) => !h.disabled).flatMap((h) => resolver.unresolved(h.value))]);
  if (missing.size) out.notes.push(`Unresolved variables: ${[...missing].map((m) => `{{${m}}}`).join(', ')}`);
  out.outgoing = outgoing;

  try {
    out.response = await send(outgoing);
  } catch (e) {
    out.error = String(e?.message || e);
    return out;
  }

  for (const target of chain) {
    const code = getScript(target, 'test');
    if (!code) continue;
    const r = await runScript(code, { ...ctxBase, phase: 'test', request: req, response: out.response });
    out.logs.push(...r.logs);
    out.tests.push(...r.tests);
    if (r.error) out.scriptErrors.push({ phase: 'Test script', where: target === collection ? 'collection' : target.name, message: r.error });
  }
  return out;
}
