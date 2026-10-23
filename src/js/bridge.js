// Calls into the Rust backend. When opened in a plain browser (for UI work),
// a small in-memory mock stands in so every screen can still be exercised.

const tauri = globalThis.__TAURI__?.core;
export const isDesktop = !!tauri;

const invoke = (cmd, args) => tauri.invoke(cmd, args);
const mock = isDesktop ? null : await import('./mock.js');
// Which profile cloud calls run as, and its region. Kept in sync by the store;
// callCtx.profileId is null for the local profile (Postman is never called).
export const callCtx = isDesktop ? { profileId: null, region: 'us' } : mock.mockCtx;

// Legacy single-region handle kept for callers that read/write region.value;
// it maps onto the active profile's region through callCtx.
export const region = {
  get value() { return callCtx.region; },
  set value(v) { callCtx.region = v === 'eu' ? 'eu' : 'us'; },
};

export const bridge = isDesktop
  ? {
      send: (request) => invoke('send_request', { request }),
      clearCookies: () => invoke('clear_cookies'),
      postman: (method, path, body) => invoke('postman_api', { method, path, body: body ?? null, profileId: callCtx.profileId ?? '', region: callCtx.region }),
      setApiKey: (key, profileId, region) => invoke('set_api_key', { key, profileId, region }),
      hasApiKey: (profileId) => invoke('has_api_key', { profileId }),
      deleteApiKey: (profileId) => invoke('delete_api_key', { profileId }),
      hasLegacyKey: () => invoke('has_legacy_api_key'),
      migrateLegacyKey: (profileId) => invoke('migrate_legacy_key', { profileId }),
      secretGet: (key) => invoke('secret_get', { key }),
      secretPut: (key, value) => invoke('secret_put', { key, value }),
      trimMemory: () => invoke('trim_memory'),
      read: (name) => invoke('store_read', { name }),
      write: (name, value) => invoke('store_write', { name, value }),
      openTextFile: () => invoke('open_text_file'),
      pickFilePath: () => invoke('pick_file_path'),
      saveTextFile: (defaultName, content) => invoke('save_text_file', { defaultName, content }),
      saveBinaryFile: (defaultName, base64Content) => invoke('save_binary_file', { defaultName, base64Content }),
      openUrl: (url) => globalThis.__TAURI__.opener.openUrl(url),
    }
  : mock.mockBridge;

if (!isDesktop) globalThis.__dispatchMock = bridge;