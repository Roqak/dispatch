// Variable scopes and {{variable}} substitution, matching Postman's precedence:
// local (pm.variables) > environment > collection > global.

import { uuid } from './model.js';

const FIRST = ['James', 'Ada', 'Tunde', 'Mei', 'Lars', 'Priya', 'Kofi', 'Sofia'];
const LAST = ['Okafor', 'Smith', 'Chen', 'Garcia', 'Adeyemi', 'Novak', 'Khan', 'Rossi'];
const pick = (a) => a[Math.floor(Math.random() * a.length)];
const rint = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;

export const DYNAMIC = {
  $guid: () => uuid(),
  $randomUUID: () => uuid(),
  $timestamp: () => String(Math.floor(Date.now() / 1000)),
  $isoTimestamp: () => new Date().toISOString(),
  $randomInt: () => String(rint(0, 1000)),
  $randomFirstName: () => pick(FIRST),
  $randomLastName: () => pick(LAST),
  $randomFullName: () => `${pick(FIRST)} ${pick(LAST)}`,
  $randomEmail: () => `${pick(FIRST).toLowerCase()}.${pick(LAST).toLowerCase()}${rint(1, 999)}@example.com`,
  $randomPhoneNumber: () => `${rint(200, 999)}-${rint(200, 999)}-${rint(1000, 9999)}`,
  $randomBoolean: () => String(Math.random() < 0.5),
  $randomAlphaNumeric: () => 'abcdefghijklmnopqrstuvwxyz0123456789'[rint(0, 35)],
  $randomColor: () => pick(['red', 'green', 'blue', 'black', 'white', 'orange', 'purple']),
  $randomPrice: () => (Math.random() * 1000).toFixed(2),
};

/**
 * A variable scope, modelled on Postman's "initial" vs "current" values.
 *
 * - `values` is the shared list that syncs with Postman (environment values use
 *   `enabled: false`, collection variables use `disabled: true`).
 * - `overlay` holds local current values. Scripts write here, so a token set by
 *   `pm.environment.set` never overwrites the shared value in your team's
 *   workspace. `null` in the overlay means "unset".
 */
export class Scope {
  constructor(values, overlay, onChange, name) {
    this.values = values || [];
    this.overlay = overlay || {};
    this.onChange = onChange || (() => {});
    this.name = name;
  }
  _initial(key) {
    return this.values.find((v) => v.key === key && v.enabled !== false && !v.disabled);
  }
  has(key) {
    if (Object.prototype.hasOwnProperty.call(this.overlay, key)) return this.overlay[key] !== null;
    return !!this._initial(key);
  }
  get(key) {
    if (Object.prototype.hasOwnProperty.call(this.overlay, key)) return this.overlay[key] ?? undefined;
    return this._initial(key)?.value;
  }
  set(key, value) {
    const str = typeof value === 'string' ? value : value === undefined ? '' : typeof value === 'object' ? JSON.stringify(value) : String(value);
    this.overlay[key] = str;
    this.onChange();
  }
  unset(key) {
    this.overlay[key] = null;
    this.onChange();
  }
  clear() {
    for (const v of this.values) this.overlay[v.key] = null;
    for (const k of Object.keys(this.overlay)) this.overlay[k] = null;
    this.onChange();
  }
  keys() {
    return [...new Set([...this.values.map((v) => v.key), ...Object.keys(this.overlay)])];
  }
  toObject() {
    const o = {};
    for (const k of this.keys()) if (this.has(k)) o[k] = this.get(k);
    return o;
  }
}

export class Resolver {
  /** scopes: { local, environment, collection, globals } as Scope instances */
  constructor(scopes) {
    this.scopes = scopes;
    this.order = ['local', 'environment', 'collection', 'globals'];
  }
  lookup(name) {
    for (const s of this.order) {
      const sc = this.scopes[s];
      if (sc?.has(name)) return { value: sc.get(name), scope: s };
    }
    if (name.startsWith('$') && DYNAMIC[name]) return { value: DYNAMIC[name](), scope: 'dynamic' };
    return null;
  }
  /** Replace {{vars}} in a string. Unknown variables are left as-is (like Postman). */
  replace(str, depth = 0) {
    if (typeof str !== 'string' || !str.includes('{{')) return str;
    const out = str.replace(/\{\{([^{}]+?)\}\}/g, (m, name) => {
      const hit = this.lookup(name.trim());
      return hit ? String(hit.value ?? '') : m;
    });
    return depth < 5 && out !== str && out.includes('{{') ? this.replace(out, depth + 1) : out;
  }
  unresolved(str) {
    const missing = [];
    String(str || '').replace(/\{\{([^{}]+?)\}\}/g, (m, name) => {
      if (!this.lookup(name.trim())) missing.push(name.trim());
      return m;
    });
    return missing;
  }
}
