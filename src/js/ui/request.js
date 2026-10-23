import { h, icon, showMenu, toast, errText, fmtBytes, fmtMs, methodClass } from './dom.js';
import { varInput, kvSection, codeArea, highlightJson, subtabs } from './components.js';
import * as C from '../ctx.js';
import * as S from '../store.js';
import { state } from '../store.js';
import { bridge } from '../bridge.js';
import { METHODS, urlObject, setRawUrl, rawWithQuery, getScript, setScript, AUTH_TYPES, authParam, setAuthParam, effectiveAuth, parseUrl, clone } from '../model.js';
import { fetchOAuthToken } from '../send.js';
import { parseCurl } from '../curl.js';
import { formatJsonc, jsonProblem } from '../jsonc.js';

// ---------- request editor ----------

export function renderRequestEditor(root, t) {
  const req = (t.draft.request = t.draft.request || { method: 'GET', header: [], url: parseUrl('') });
  req.url = urlObject(req.url);
  req.header = req.header || [];
  const resolver = () => C.resolverFor(t);
  const dirty = () => C.markDirty(t);
  const { entry, collection, parents } = C.contextFor(t);

  // breadcrumb + name + save
  const path = entry ? [entry.name, ...parents.map((p) => p.name)].join(' / ') : null;
  const nameInput = h('input', { class: 'name-input', value: t.draft.name, spellcheck: 'false', oninput: (e) => { t.draft.name = e.target.value; dirty(); C.emitTabs(); } });
  const crumbs = h('div', { class: 'crumbs' },
    path ? h('span', { class: 'path', title: path }, `${path} /`) : h('span', { class: 'badge local' }, 'Not saved'),
    nameInput,
    h('span', { class: 'grow' }),
    h('button', { class: 'icon-btn', title: state.settings.layout === 'side' ? 'Show the response below (⌥⌘V)' : 'Show the response beside the request (⌥⌘V)', onclick: () => S.toggleLayout() }, icon(state.settings.layout === 'side' ? 'rows' : 'columns')),
    h('button', { class: 'btn sm', title: 'Save (⌘S)', onclick: () => C.saveTab(t) }, icon('check'), t.ref?.col ? 'Save' : 'Save to collection'),
    h('button', { class: 'icon-btn', title: 'More', onclick: (e) => showMenu(e, [
      { label: 'Copy as cURL', icon: 'terminal', onClick: async () => { await navigator.clipboard.writeText(C.curlFor(t)); toast('Copied cURL command'); } },
      { label: 'Save as new request…', icon: 'copy', onClick: async () => { const { saveAsDialog } = await import('./panels.js'); const r = await saveAsDialog(`${t.draft.name} Copy`); if (r) { const nt = C.openDraft(clone(t.draft)); await C.saveRequestInto(nt, r.entry, r.folderId, r.name); } } },
      t.ref?.col && t.dirty ? { label: 'Discard changes', icon: 'sync', onClick: () => { const f = C.contextFor(t).item; if (f) { t.draft = clone(f); t.dirty = false; C.emitAll(); } } } : null,
    ].filter(Boolean)) }, icon('more')));

  // method + URL + send
  const methodSel = h('select', { class: ['select method-select', methodClass(req.method)], onchange: (e) => { req.method = e.target.value; methodSel.className = `select method-select ${methodClass(req.method)}`; dirty(); C.emitTabs(); } },
    [...new Set([...METHODS, req.method || 'GET'])].map((m) => h('option', { value: m, selected: m === (req.method || 'GET') }, m)));
  const urlField = varInput({
    value: req.url.raw || '', placeholder: 'Enter a URL, or paste a cURL command', resolver,
    oninput: (v) => {
      if (/^\s*curl\s/i.test(v)) return; // handled on paste
      setRawUrl(req, v);
      dirty();
      if (t.sub === 'params') renderPane();
    },
    onkeydown: (e) => { if (e.key === 'Enter') { e.preventDefault(); C.run(t); } },
  });
  urlField.classList.add('url-wrap');
  urlField.style.height = '100%';
  urlField.input.addEventListener('paste', (e) => {
    const text = e.clipboardData?.getData('text') || '';
    if (!/^\s*curl\s/i.test(text)) return;
    e.preventDefault();
    try {
      const parsed = parseCurl(text);
      Object.assign(req, parsed);
      dirty();
      toast('Imported the cURL command');
      C.emitAll();
    } catch (err) { toast(errText(err), { error: true }); }
  });
  const sendBtn = h('button', { class: 'btn primary send-btn', disabled: t.running, onclick: () => C.run(t) }, t.running ? 'Sending…' : 'Send');
  const reqline = h('div', { class: 'reqline' }, h('div', { class: 'reqline-box' }, methodSel, urlField), sendBtn);

  // sub tabs
  const enabledCount = (a) => (a || []).filter((x) => !x.disabled && x.key).length;
  const hasScripts = !!(getScript(t.draft, 'prerequest') || getScript(t.draft, 'test'));
  const authType = req.auth?.type || 'inherit';
  const tabsDef = [
    { id: 'params', label: 'Params', count: enabledCount(req.url.query) || '' },
    { id: 'auth', label: 'Authorization', dot: authType !== 'inherit' && authType !== 'noauth' },
    { id: 'headers', label: 'Headers', count: enabledCount(req.header) || '' },
    { id: 'body', label: 'Body', dot: !!req.body?.mode && req.body.mode !== 'none' && !isEmptyBody(req.body) },
    { id: 'scripts', label: 'Scripts', dot: hasScripts },
    { id: 'settings', label: 'Settings' },
  ];
  const tabsHolder = h('div');
  const pane = h('div', { class: 'pane' });
  const renderTabs = () => tabsHolder.replaceChildren(subtabs(tabsDef, t.sub, (id) => { t.sub = id; renderTabs(); renderPane(); C.saveTabsLater(); }));

  function renderPane() {
    pane.replaceChildren();
    const sub = t.sub;
    if (sub === 'params') {
      const query = (req.url.query = req.url.query || []);
      pane.append(kvSection({ title: 'Query params', rows: query, resolver, kind: 'params', onChange: () => {
        req.url.raw = rawWithQuery(req.url.raw || '', query);
        urlField.setValue(req.url.raw);
        dirty();
      } }));
      if ((req.url.variable || []).length) {
        pane.append(h('div', { style: { height: '14px' } }), kvSection({ title: 'Path variables', rows: req.url.variable, resolver, kind: 'pathvars', onChange: dirty }));
      }
    } else if (sub === 'auth') {
      pane.append(authEditor({ target: req, kind: 'request', parents, collection, resolver, onChange: () => { dirty(); }, onTypeChange: () => { renderTabs(); renderPane(); }, tab: t }));
    } else if (sub === 'headers') {
      pane.append(kvSection({ title: 'Headers', rows: req.header, resolver, kind: 'headers', onChange: () => { dirty(); } }));
      const { auth, source } = effectiveAuth(req, parents, collection);
      pane.append(h('p', { class: 'hint' }, 'Dispatch adds ', h('span', { class: 'mono' }, 'Accept: */*'), ' and a Content-Type matching the body when you haven\'t set them.', auth ? ` Auth headers come from ${source === 'request' ? 'the Authorization tab' : `the ${source === 'collection' ? 'collection' : `"${source}" folder`}`}.` : ''));
    } else if (sub === 'body') {
      pane.append(bodyEditor(req, resolver, dirty, () => { renderTabs(); }));
    } else if (sub === 'scripts') {
      pane.append(scriptsEditor(t.draft, t, dirty, () => renderTabs()));
    } else if (sub === 'settings') {
      pane.append(requestSettings(t.draft, dirty));
    }
  }
  renderTabs();
  renderPane();

  root.replaceChildren(crumbs, reqline, tabsHolder, pane);
  root.focusUrl = () => urlField.input.focus();
  root.repaintVars = () => { urlField.repaint(); pane.querySelectorAll('.var-input').forEach((v) => v.repaint?.()); };
}

/**
 * Pretty-print a JSON body that may contain {{variables}} (inside strings or
 * bare, e.g. "amount": {{amount}}) and // or /* *\/ comments, keeping both.
 * Throws when the JSON itself isn't valid.
 */
export function beautifyJson(text) {
  const problem = jsonProblem(text);
  if (problem) throw new Error(problem);
  return formatJsonc(text);
}

function isEmptyBody(b) {
  if (b.mode === 'raw') return !b.raw;
  if (b.mode === 'urlencoded') return !(b.urlencoded || []).length;
  if (b.mode === 'formdata') return !(b.formdata || []).length;
  if (b.mode === 'graphql') return !b.graphql?.query;
  if (b.mode === 'file') return !b.file?.src;
  return true;
}

// ---------- auth ----------

export function authEditor({ target, kind, parents = [], collection, resolver, onChange, onTypeChange, tab }) {
  const box = h('div');
  const types = kind === 'collection' ? AUTH_TYPES.filter(([id]) => id !== 'inherit') : AUTH_TYPES;
  const known = types.map(([id]) => id);
  const current = target.auth?.type || (kind === 'collection' ? 'noauth' : 'inherit');
  const select = h('select', { class: 'select', onchange: (e) => {
    const type = e.target.value;
    if (type === 'inherit') delete target.auth;
    else {
      const prev = target.auth;
      target.auth = { ...(prev || {}), type };
      if (type !== 'noauth' && !Array.isArray(target.auth[type])) target.auth[type] = [];
    }
    onChange();
    onTypeChange?.();
  } },
    types.map(([id, label]) => h('option', { value: id, selected: id === current }, label)),
    !known.includes(current) ? h('option', { value: current, selected: true }, `${current} (kept as is)`) : null);

  const field = (label, key, { secret = false, placeholder = '' } = {}) => {
    const input = varInput({ value: String(authParam(target.auth, key) ?? ''), placeholder, resolver, oninput: (v) => { setAuthParam(target.auth, key, v); onChange(); } });
    if (secret) input.input.type = 'password';
    return [h('label', null, label), secret ? h('div', { class: 'row' }, h('div', { class: 'grow' }, input), h('button', { class: 'icon-btn', title: 'Show', onclick: () => { input.input.type = input.input.type === 'password' ? 'text' : 'password'; } }, icon('eye'))) : input];
  };
  const choice = (label, key, options, def) => {
    const v = authParam(target.auth, key) ?? def;
    return [h('label', null, label), h('select', { class: 'select', onchange: (e) => { setAuthParam(target.auth, key, e.target.value); onChange(); onTypeChange?.(); } }, options.map(([id, l]) => h('option', { value: id, selected: id === v }, l)))];
  };

  const grid = h('div', { class: 'form-grid' }, h('label', null, 'Auth type'), select);
  box.append(grid);

  if (current === 'inherit') {
    const { auth, source } = effectiveAuth({}, parents, collection);
    const label = auth ? AUTH_TYPES.find(([id]) => id === auth.type)?.[1] || auth.type : 'No Auth';
    box.append(h('div', { class: 'inherit-box', style: { marginTop: '14px' } },
      auth ? h('span', null, 'This request uses ', h('b', null, label), ` from ${source === 'collection' ? 'the collection' : `the "${source}" folder`}.`) : 'Nothing above this request sets auth, so it is sent without any.'));
  } else if (current === 'noauth') {
    box.append(h('p', { class: 'hint', style: { marginTop: '12px' } }, 'No authorization is sent.'));
  } else if (current === 'bearer') {
    grid.append(...field('Token', 'token', { secret: true, placeholder: 'Token or {{variable}}' }));
  } else if (current === 'basic') {
    grid.append(...field('Username', 'username'), ...field('Password', 'password', { secret: true }));
  } else if (current === 'apikey') {
    grid.append(...field('Key', 'key', { placeholder: 'e.g. X-API-Key' }), ...field('Value', 'value', { secret: true }), ...choice('Add to', 'in', [['header', 'Header'], ['query', 'Query params']], 'header'));
  } else if (current === 'oauth2') {
    const grant = authParam(target.auth, 'grant_type') || 'client_credentials';
    grid.append(
      ...field('Current token', 'accessToken', { secret: true, placeholder: 'Paste a token or get a new one below' }),
      ...field('Header prefix', 'headerPrefix', { placeholder: 'Bearer' }),
      ...choice('Add token to', 'addTokenTo', [['header', 'Request headers'], ['queryParams', 'Query params']], 'header'),
      h('div', { class: 'full pane-title', style: { marginTop: '14px' } }, 'Get a new access token'),
      ...choice('Grant type', 'grant_type', [['client_credentials', 'Client Credentials'], ['password_credentials', 'Password Credentials'], ['authorization_code', 'Authorization Code (paste token above)']], 'client_credentials'),
    );
    if (grant !== 'authorization_code') {
      grid.append(
        ...field('Access token URL', 'accessTokenUrl', { placeholder: 'https://auth.example.com/oauth/token' }),
        ...field('Client ID', 'clientId'),
        ...field('Client secret', 'clientSecret', { secret: true }),
        ...field('Scope', 'scope', { placeholder: 'Optional' }),
      );
      if (grant === 'password_credentials') grid.append(...field('Username', 'username'), ...field('Password', 'password', { secret: true }));
      grid.append(...choice('Client authentication', 'client_authentication', [['header', 'Send as Basic Auth header'], ['body', 'Send client credentials in body']], 'header'));
      const btn = h('button', { class: 'btn primary', onclick: async () => {
        btn.disabled = true; btn.textContent = 'Getting token…';
        try {
          const tok = await fetchOAuthToken(target.auth, resolver(), (r) => bridge.send(r), state.settings);
          setAuthParam(target.auth, 'accessToken', tok.access_token);
          if (tok.token_type && !authParam(target.auth, 'headerPrefix')) setAuthParam(target.auth, 'headerPrefix', tok.token_type.toLowerCase() === 'bearer' ? 'Bearer' : tok.token_type);
          onChange();
          onTypeChange?.();
          toast(`Got a new access token${tok.expires_in ? ` (expires in ${Math.round(tok.expires_in / 60)} min)` : ''}`);
        } catch (e) { toast(errText(e), { error: true }); btn.disabled = false; btn.textContent = 'Get new access token'; }
      } }, 'Get new access token');
      grid.append(h('span'), h('div', null, btn));
    } else {
      grid.append(h('p', { class: 'hint full' }, 'Dispatch can\'t open a browser sign-in for the authorization code flow yet. Get a token elsewhere (for example in Postman) and paste it into "Current token".'));
    }
  } else {
    box.append(h('div', { class: 'note warn', style: { marginTop: '12px' } }, icon('alert'), h('span', null, `Dispatch can't edit or apply "${current}" auth yet. It's kept exactly as is and stays in sync with Postman, but requests here are sent without it.`)));
  }
  return box;
}

// ---------- body ----------

function bodyEditor(req, resolver, dirty, onModeChange) {
  const wrap = h('div', { class: 'split-pane' });
  const body = (req.body = req.body || { mode: 'none' });
  const modes = [['none', 'none'], ['formdata', 'form-data'], ['urlencoded', 'x-www-form-urlencoded'], ['raw', 'raw'], ['file', 'binary'], ['graphql', 'GraphQL']];
  const lang = body.options?.raw?.language || 'json';
  const render = () => {
    const mode = body.mode || 'none';
    const radios = h('div', { class: 'radio-row' }, modes.map(([id, label]) => h('label', { class: id === mode ? 'on' : '' },
      h('input', { type: 'radio', name: `bm-${Math.random()}`, checked: id === mode, onchange: () => {
        body.mode = id;
        if (id === 'raw' && body.raw === undefined) body.raw = '';
        if (id === 'raw' && !body.options?.raw?.language) body.options = { ...(body.options || {}), raw: { language: 'json' } };
        dirty(); onModeChange(); render();
      } }), label)));
    const parts = [radios];
    if (mode === 'raw') {
      const curLang = body.options?.raw?.language || lang;
      const langSel = h('select', { class: 'select', style: { height: '26px', fontSize: '12px' }, onchange: (e) => { body.options = { ...(body.options || {}), raw: { ...(body.options?.raw || {}), language: e.target.value } }; dirty(); } },
        [['json', 'JSON'], ['text', 'Text'], ['javascript', 'JavaScript'], ['html', 'HTML'], ['xml', 'XML']].map(([id, l]) => h('option', { value: id, selected: id === curLang }, l)));
      const ta = codeArea({ value: body.raw || '', placeholder: curLang === 'json' ? '{\n  "key": "value"\n}' : '', oninput: (v) => { body.raw = v; dirty(); } });
      const beautify = h('button', { class: 'btn ghost sm', onclick: () => {
        try {
          const out = beautifyJson(ta.value);
          ta.value = out; body.raw = out; dirty();
        } catch (e) { toast(`That isn't valid JSON yet: ${e.message}`, { error: true }); }
      } }, 'Beautify');
      parts.push(h('div', { class: 'row', style: { marginBottom: '8px' } }, langSel, h('span', { class: 'grow' }), beautify), h('div', { class: 'code-wrap' }, ta));
    } else if (mode === 'urlencoded') {
      parts.push(kvSection({ rows: (body.urlencoded = body.urlencoded || []), resolver, kind: 'urlencoded', onChange: dirty }));
    } else if (mode === 'formdata') {
      parts.push(kvSection({ rows: (body.formdata = body.formdata || []), resolver, kind: 'form', onChange: dirty, pickFile: () => bridge.pickFilePath() }));
    } else if (mode === 'file') {
      const src = body.file?.src;
      parts.push(h('div', { class: 'row' }, h('button', { class: 'btn', onclick: async () => { const p = await bridge.pickFilePath(); if (p) { body.file = { src: p }; dirty(); render(); } } }, icon('file'), src ? 'Change file' : 'Choose file'), h('span', { class: 'mono muted ellipsis' }, src || 'No file chosen')));
    } else if (mode === 'graphql') {
      body.graphql = body.graphql || { query: '', variables: '' };
      parts.push(h('div', { class: 'pane-title' }, 'Query'), codeArea({ value: body.graphql.query || '', minHeight: 140, placeholder: 'query {\n  viewer { id }\n}', oninput: (v) => { body.graphql.query = v; dirty(); } }),
        h('div', { class: 'pane-title', style: { marginTop: '12px' } }, 'Variables (JSON)'), codeArea({ value: body.graphql.variables || '', minHeight: 80, oninput: (v) => { body.graphql.variables = v; dirty(); } }));
    } else {
      parts.push(h('p', { class: 'hint' }, 'This request has no body.'));
    }
    wrap.replaceChildren(...parts);
  };
  render();
  return wrap;
}

// ---------- scripts ----------

const SNIPPETS = {
  prerequest: [
    ['Set an environment variable', "pm.environment.set('name', 'value');"],
    ['Set a collection variable', "pm.collectionVariables.set('name', 'value');"],
    ['Add a header', "pm.request.headers.upsert({ key: 'X-Request-Id', value: pm.variables.replaceIn('{{$guid}}') });"],
    ['Sign the body with HMAC-SHA256', "const sig = CryptoJS.HmacSHA256(pm.request.body.raw || '', pm.environment.get('secret')).toString(CryptoJS.enc.Hex);\npm.request.headers.upsert({ key: 'X-Signature', value: sig });"],
    ['Send a request first', "pm.sendRequest({\n  url: pm.variables.replaceIn('{{baseUrl}}/token'),\n  method: 'POST',\n  header: { 'Content-Type': 'application/json' },\n  body: { mode: 'raw', raw: JSON.stringify({ id: pm.environment.get('clientId') }) }\n}, (err, res) => {\n  if (!err) pm.environment.set('token', res.json().token);\n});"],
  ],
  test: [
    ['Status code is 200', "pm.test('Status code is 200', () => {\n  pm.response.to.have.status(200);\n});"],
    ['Response time under 500 ms', "pm.test('Response time is under 500 ms', () => {\n  pm.expect(pm.response.responseTime).to.be.below(500);\n});"],
    ['Check a JSON value', "pm.test('Has the expected value', () => {\n  const json = pm.response.json();\n  pm.expect(json.status).to.eql('success');\n});"],
    ['Save a value for later requests', "const json = pm.response.json();\npm.environment.set('token', json.token);"],
    ['Header exists', "pm.test('Content-Type is present', () => {\n  pm.response.to.have.header('Content-Type');\n});"],
  ],
};

export function scriptsEditor(target, t, dirty, onChange) {
  const wrap = h('div', { class: 'split-pane' });
  const render = () => {
    const phase = t.scriptTab || 'prerequest';
    const seg = h('div', { class: 'seg' },
      h('button', { class: phase === 'prerequest' ? 'on' : '', onclick: () => { t.scriptTab = 'prerequest'; render(); } }, 'Pre-request', getScript(target, 'prerequest') ? ' •' : ''),
      h('button', { class: phase === 'test' ? 'on' : '', onclick: () => { t.scriptTab = 'test'; render(); } }, 'Post-response', getScript(target, 'test') ? ' •' : ''));
    const ta = codeArea({ value: getScript(target, phase), placeholder: phase === 'prerequest' ? '// Runs before the request is sent\n// e.g. pm.environment.set("timestamp", Date.now());' : '// Runs after the response arrives\n// e.g. pm.test("Status is 200", () => pm.response.to.have.status(200));', oninput: (v) => { setScript(target, phase, v); dirty(); onChange?.(); } });
    const snip = h('button', { class: 'btn ghost sm', onclick: (e) => showMenu(e, SNIPPETS[phase].map(([label, code]) => ({ label, onClick: () => {
      const cur = ta.value;
      ta.value = cur ? `${cur.replace(/\s*$/, '')}\n\n${code}\n` : `${code}\n`;
      setScript(target, phase, ta.value); dirty(); onChange?.(); ta.focus();
    } }))) }, 'Snippets');
    wrap.replaceChildren(
      h('div', { class: 'row', style: { marginBottom: '8px' } }, seg, h('span', { class: 'grow' }), snip),
      h('div', { class: 'code-wrap' }, ta),
      h('p', { class: 'hint', style: { marginBottom: 0 } }, 'Uses Postman\'s pm API. Built in: ', h('span', { class: 'mono' }, 'CryptoJS'), ', ', h('span', { class: 'mono' }, 'require("lodash")'), ', ', h('span', { class: 'mono' }, 'chai'), ', ', h('span', { class: 'mono' }, 'uuid'), ', ', h('span', { class: 'mono' }, 'atob/btoa'), '. Collection and folder scripts run first.'),
    );
  };
  render();
  return wrap;
}

function requestSettings(item, dirty) {
  const ppb = item.protocolProfileBehavior || {};
  const tri = (label, key, help) => h('div', { class: 'settings-row' },
    h('div', { class: 'form-grid', style: { marginBottom: '12px' } },
      h('label', null, label),
      h('select', { class: 'select', style: { maxWidth: '260px' }, onchange: (e) => {
        item.protocolProfileBehavior = item.protocolProfileBehavior || {};
        if (e.target.value === 'default') delete item.protocolProfileBehavior[key];
        else item.protocolProfileBehavior[key] = e.target.value === 'on';
        if (!Object.keys(item.protocolProfileBehavior).length) delete item.protocolProfileBehavior;
        dirty();
      } },
        h('option', { value: 'default', selected: ppb[key] === undefined }, `Use app setting (${state.settings[key === 'strictSSL' ? 'verifySsl' : key] ? 'on' : 'off'})`),
        h('option', { value: 'on', selected: ppb[key] === true }, 'On'),
        h('option', { value: 'off', selected: ppb[key] === false }, 'Off')),
      h('span'), h('span', { class: 'hint', style: { margin: 0 } }, help)));
  return h('div', null,
    tri('Follow redirects', 'followRedirects', 'Follow 3xx responses automatically.'),
    tri('Verify SSL certificates', 'strictSSL', 'Turn off for local servers with self-signed certificates.'));
}

// ---------- response ----------

export function renderResponse(root, t) {
  const r = t.response;
  if (t.running) {
    root.replaceChildren(h('div', { class: 'loading-bar' }), h('div', { class: 'resp-empty' }, h('div', null, 'Sending request…')));
    return;
  }
  if (!r) {
    root.replaceChildren(h('div', { class: 'resp-empty' }, h('div', null, icon('send'), h('div', null, 'Send the request to see the response'),
      h('div', { class: 'keys' }, h('span', null, h('kbd', null, '⌘'), ' ', h('kbd', null, '↵'), ' Send'), h('span', null, h('kbd', null, '⌘'), ' ', h('kbd', null, 'S'), ' Save')))));
    return;
  }
  const res = r.response;
  const tests = r.tests || [];
  const passed = tests.filter((x) => x.passed === true).length;
  const failedTests = tests.filter((x) => x.passed === false).length;
  const tabsDef = [
    { id: 'body', label: 'Body' },
    { id: 'headers', label: 'Headers', count: res?.headers?.length || '' },
    { id: 'tests', label: tests.length ? `Tests ${passed}/${tests.length}` : 'Tests' },
    { id: 'console', label: 'Console', count: r.logs?.length || '' },
  ];
  const statusCls = res ? `s${String(res.status)[0]}` : '';
  const meta = res ? h('div', { class: 'resp-meta' },
    h('span', { class: ['status-pill', statusCls] }, `${res.status} ${res.statusText || ''}`.trim()),
    h('span', null, h('b', null, fmtMs(res.timeMs))),
    h('span', null, h('b', null, fmtBytes(res.size))),
    failedTests ? h('span', { style: { color: 'var(--err)' } }, `${failedTests} failed`) : null,
    h('button', { class: 'icon-btn', title: 'More', onclick: (e) => showMenu(e, [
      { label: 'Copy body', icon: 'copy', onClick: async () => { await navigator.clipboard.writeText(res.bodyText ?? ''); toast('Copied'); } },
      { label: 'Save body to file…', icon: 'download', onClick: async () => {
        const ext = res.contentType.includes('json') ? 'json' : res.contentType.includes('html') ? 'html' : res.contentType.includes('xml') ? 'xml' : res.bodyBase64 ? 'bin' : 'txt';
        const p = res.bodyBase64 ? await bridge.saveBinaryFile(`response.${ext}`, res.bodyBase64) : await bridge.saveTextFile(`response.${ext}`, res.bodyText || '');
        if (p) toast(`Saved to ${p}`);
      } },
      t.ref?.col ? { label: 'Save as example', icon: 'check', onClick: () => saveExample(t) } : null,
    ].filter(Boolean)) }, icon('more'))) : null;

  const head = h('div', { class: 'resp-head' }, subtabs(tabsDef, t.respTab, (id) => { t.respTab = id; renderResponse(root, t); }), meta);
  const body = h('div', { class: 'resp-body' });

  const notes = [
    ...(r.notes || []).map((n) => h('div', { class: 'note warn', style: { margin: '10px 14px 0' } }, icon('info'), h('span', null, n))),
    ...(r.scriptErrors || []).filter((s) => r.response).map((s) => h('div', { class: 'note err', style: { margin: '10px 14px 0' } }, icon('alert'), h('span', null, `${s.phase} error in ${s.where === 'collection' ? 'the collection' : `"${s.where}"`}: ${s.message}`))),
  ];

  if (!res) {
    body.append(...notes, h('div', { class: 'resp-error' },
      h('h3', null, r.error ? 'Could not send request' : 'Nothing was sent'),
      h('p', null, r.error || (r.notes || []).join(' ')),
      r.outgoing ? h('p', { class: 'mono' }, `${r.outgoing.method} ${r.outgoing.url}`) : null));
    if (t.respTab === 'console') body.replaceChildren(consoleView(r));
  } else if (t.respTab === 'body') {
    body.append(...notes, bodyView(res, t));
  } else if (t.respTab === 'headers') {
    body.append(h('table', { class: 'hdr-table' }, res.headers.map((x) => h('tr', null, h('td', null, x.key), h('td', null, x.value)))));
  } else if (t.respTab === 'tests') {
    if (!tests.length) body.append(h('div', { class: 'resp-empty' }, h('div', null, 'No tests ran. Add some in the Scripts tab → Post-response.')));
    else body.append(...tests.map((x) => h('div', { class: 'test-row' },
      h('span', { class: ['tag', x.skipped ? 'skip' : x.passed ? 'pass' : 'fail'] }, x.skipped ? 'SKIP' : x.passed ? 'PASS' : 'FAIL'),
      h('div', null, h('div', null, x.name), x.error ? h('div', { class: 'err' }, x.error) : null))));
  } else if (t.respTab === 'console') {
    body.append(consoleView(r));
  }
  root.replaceChildren(head, body);
}

function consoleView(r) {
  const o = r.outgoing;
  const rows = [];
  if (o) {
    rows.push(h('div', { class: 'log-row' }, h('span', { class: 'lv' }, 'req'), h('pre', null, `${o.method} ${o.url}\n${o.headers.map((x) => `${x.key}: ${x.value}`).join('\n')}${o.body.mode === 'raw' ? `\n\n${o.body.content}` : o.body.mode !== 'none' ? `\n\n[${o.body.mode} body]` : ''}`)));
  }
  for (const l of r.logs || []) rows.push(h('div', { class: ['log-row', l.level] }, h('span', { class: 'lv' }, l.level), h('pre', null, l.message)));
  for (const s of r.scriptErrors || []) rows.push(h('div', { class: 'log-row error' }, h('span', { class: 'lv' }, 'error'), h('pre', null, `${s.phase} (${s.where}): ${s.message}`)));
  if (!rows.length) return h('div', { class: 'resp-empty' }, h('div', null, 'console.log output from scripts shows up here.'));
  return h('div', null, rows);
}

function bodyView(res, t) {
  const ct = (res.contentType || '').toLowerCase();
  const isJson = ct.includes('json') || (/^\s*[{[]/.test(res.bodyText || '') && safeParse(res.bodyText) !== undefined);
  const isHtml = ct.includes('html');
  const isImage = ct.startsWith('image/');
  t.bodyView = t.bodyView || 'pretty';
  const view = t.bodyView;
  const wrapOn = !!t.wrap;
  const container = h('div');
  const tools = h('div', { class: 'resp-tools' },
    h('div', { class: 'seg' },
      ['pretty', 'raw', ...(isHtml || isImage ? ['preview'] : [])].map((v) => h('button', { class: view === v ? 'on' : '', onclick: () => { t.bodyView = v; container.replaceWith(bodyView(res, t)); } }, v[0].toUpperCase() + v.slice(1)))),
    h('span', { class: 'grow' }),
    isJson ? h('span', { class: 'faint', style: { fontSize: '12px' } }, 'JSON') : h('span', { class: 'faint', style: { fontSize: '12px' } }, ct.split(';')[0] || ''),
    h('button', { class: ['icon-btn', wrapOn && 'on'], title: wrapOn ? 'Turn off line wrap' : 'Wrap lines', style: wrapOn ? { color: 'var(--accent)' } : null, onclick: () => { t.wrap = !wrapOn; container.replaceWith(bodyView(res, t)); } }, icon('wrap')),
    h('button', { class: 'icon-btn', title: 'Copy', onclick: async () => { await navigator.clipboard.writeText(res.bodyText ?? ''); toast('Copied'); } }, icon('copy')));
  container.append(tools);

  if (view === 'preview' && isImage && res.bodyBase64) {
    container.append(h('img', { class: 'preview-img', src: `data:${ct.split(';')[0]};base64,${res.bodyBase64}` }));
  } else if (view === 'preview' && isHtml) {
    const frame = h('iframe', { class: 'preview-frame', sandbox: '', style: { height: '60vh' } });
    frame.srcdoc = res.bodyText || '';
    container.append(frame);
  } else if (res.bodyBase64) {
    container.append(h('div', { class: 'resp-empty', style: { height: 'auto', padding: '40px' } }, h('div', null, `Binary response (${fmtBytes(res.size)}). Use ⋯ → Save body to file.`)));
  } else {
    const text = res.bodyText || '';
    const pre = h('pre', { class: ['body', wrapOn && 'wrap'] });
    if (view === 'pretty' && isJson && text.length < 3_000_000) {
      const parsed = safeParse(text);
      const pretty = parsed !== undefined ? JSON.stringify(parsed, null, 2) : text;
      pre.innerHTML = pretty.length < 1_500_000 ? highlightJson(pretty) : '';
      if (pretty.length >= 1_500_000) pre.textContent = pretty;
    } else if (view === 'pretty' && (ct.includes('xml') || isHtml) && text.length < 1_000_000) {
      pre.textContent = prettyXml(text);
    } else {
      pre.textContent = text || '(empty body)';
    }
    container.append(pre);
  }
  return container;
}

function safeParse(s) { try { return JSON.parse(s); } catch { return undefined; } }

function prettyXml(xml) {
  if (xml.includes('\n') && /\n\s+</.test(xml)) return xml;
  let pad = 0;
  return xml.replace(/>\s*</g, '>\n<').split('\n').map((line) => {
    if (/^<\/\w/.test(line)) pad = Math.max(0, pad - 1);
    const out = '  '.repeat(pad) + line;
    if (/^<\w[^>]*[^/]>.*$/.test(line) && !/<\/\w/.test(line) && !/^<(br|hr|img|input|meta|link)\b/i.test(line)) pad++;
    return out;
  }).join('\n');
}

async function saveExample(t) {
  const res = t.response?.response;
  if (!res) return;
  const name = `${res.status} ${res.statusText || ''}`.trim();
  t.draft.response = t.draft.response || [];
  t.draft.response.push({
    name,
    originalRequest: clone(t.draft.request),
    status: res.statusText,
    code: res.status,
    _postman_previewlanguage: (res.contentType || '').includes('json') ? 'json' : 'text',
    header: res.headers.map((x) => ({ key: x.key, value: x.value })),
    cookie: [],
    body: res.bodyText ?? '',
  });
  C.markDirty(t);
  await C.saveTab(t);
}
