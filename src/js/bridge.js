// Calls into the Rust backend. When opened in a plain browser (for UI work),
// a small in-memory mock stands in so every screen can still be exercised.

const tauri = globalThis.__TAURI__?.core;
export const isDesktop = !!tauri;

const invoke = (cmd, args) => tauri.invoke(cmd, args);
// Set from settings by the store; 'us' (default) or 'eu'.
export const region = { value: 'us' };

export const bridge = isDesktop
  ? {
      send: (request) => invoke('send_request', { request }),
      clearCookies: () => invoke('clear_cookies'),
      postman: (method, path, body) => invoke('postman_api', { method, path, body: body ?? null, region: region.value }),
      setApiKey: (key) => invoke('set_api_key', { key, region: region.value }),
      hasApiKey: () => invoke('has_api_key'),
      deleteApiKey: () => invoke('delete_api_key'),
      read: (name) => invoke('store_read', { name }),
      write: (name, value) => invoke('store_write', { name, value }),
      openTextFile: () => invoke('open_text_file'),
      pickFilePath: () => invoke('pick_file_path'),
      saveTextFile: (defaultName, content) => invoke('save_text_file', { defaultName, content }),
      saveBinaryFile: (defaultName, base64Content) => invoke('save_binary_file', { defaultName, base64Content }),
    }
  : (await import('./mock.js')).mockBridge;

if (!isDesktop) globalThis.__dispatchMock = bridge;
