# Dispatch

A lightweight API client for macOS that works with your existing Postman account. It reads and writes your workspaces, collections, environments and globals through Postman's official API, so your team can keep using Postman while you use something smaller.

The app is a native Tauri build. The release binary is about 6 MB, compared with several hundred MB for the Postman desktop app.

## What it does

- **Two-way sync with Postman.** Open any workspace you can see in Postman. Saving a request, folder, collection or environment pushes it back, and changes your teammates make are pulled in when you sync (the ↻ button, or automatically when the window regains focus).
- **Conflict detection.** If a collection changed in Postman after you last synced, Dispatch asks before saving: overwrite with your version, or load theirs. Loading theirs keeps your edits in your open tabs so you can re-apply them.
- **Requests.** All common methods, query and path parameters, headers, and bodies as raw text/JSON/XML/HTML, form-data (including file uploads), x-www-form-urlencoded, binary files and GraphQL. Requests are sent from Rust, so there are no browser CORS limits. Cookies persist for the session.
- **Variables.** `{{variables}}` resolve in the same order as Postman: local, environment, collection, then globals. Dynamic variables such as `{{$guid}}`, `{{$timestamp}}` and `{{$randomEmail}}` work too. The URL bar highlights each variable green when it's defined and red when it isn't.
- **Shared and current values.** As in Postman, the shared value of a variable syncs with your team. The current value stays on your Mac, and that's where scripts write. A token saved by `pm.environment.set()` never overwrites the value your teammates see.
- **Auth.** Inherit from parent, No Auth, Bearer token, Basic, API key (header or query), and OAuth 2.0 with a "Get new access token" button for the client credentials and password grants. Auth types Dispatch can't apply yet are left untouched so they round-trip safely.
- **Scripts.** Pre-request and post-response scripts run with Postman's `pm` API: `pm.environment`, `pm.collectionVariables`, `pm.globals`, `pm.variables`, `pm.request`, `pm.response`, `pm.test`, `pm.expect`, `pm.sendRequest` and `console.log`. Collection and folder scripts run before the request's own. The real `chai`, `crypto-js` and `lodash` libraries are bundled, so request-signing scripts that use `CryptoJS.MD5` or `CryptoJS.HmacSHA256` work as they do in Postman.
- **History.** The last 300 requests you sent, grouped by day. Click one to reopen it in a new tab.
- **Import and export.** Postman collection (v2.0 and v2.1) and environment JSON files. Importing into a synced workspace also uploads the file to Postman.
- **cURL.** Paste a `curl` command into the URL bar to turn it into a request. "Copy as cURL" from the ⋯ menu goes the other way.
- **Everyday editing.** Tabs that survive restarts, drag-and-drop reordering in the sidebar, bulk edit for headers and params, JSON beautify, response pretty-printing and HTML/image previews, saving responses as examples, and light and dark themes.

## Build it on your Mac

You need macOS 13 (Ventura) or later. The build compiles everything from source on your machine, which takes about five minutes the first time.

1. Install Apple's command line tools, if you don't already have them:
   ```bash
   xcode-select --install
   ```
2. Install Rust:
   ```bash
   curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
   ```
   Then open a new Terminal window so the `cargo` command is available.
3. Install Node.js 18 or later from nodejs.org, or with Homebrew (`brew install node`). It's only used to run the Tauri build tool.
4. In the project folder, build the app:
   ```bash
   npm install
   npm run build
   ```
5. The finished app is at `src-tauri/target/release/bundle/macos/Dispatch.app`, with a disk image next to it in `bundle/dmg/`. Drag `Dispatch.app` into your Applications folder.

Because you built it yourself, macOS opens it without any Gatekeeper warning.

To run a development copy with live reloading of the interface, use `npm run dev` instead of `npm run build`.

### Building with GitHub instead

If you'd rather not install the tools, push this folder to a GitHub repository. The included workflow (`.github/workflows/build-macos.yml`) builds a universal disk image for Apple Silicon and Intel Macs, which you can download from the run's **Artifacts** section. That copy isn't notarized, so the first time you open it, right-click the app and choose **Open**.

## Connect your Postman account

1. In Postman, click your avatar, then **Settings → API keys → Generate API key**.
2. Paste the key into Dispatch when it asks. Dispatch checks the key with Postman before saving it in your macOS Keychain.
3. If your Postman team is hosted in the EU region, tick the EU box before connecting.

You can skip this step and use the "On this Mac" workspace, which never syncs.

## How syncing works

Dispatch only uses Postman's public, documented API with your own key. It doesn't use the private sync channel that the Postman desktop app relies on.

Each save of a collection uses two or three API calls: one to check whether Postman has a newer version, one to upload, and one to record the new version. Postman limits API calls per month depending on your plan. If that limit is tight for you, open **Settings** and choose **Keep local until I push**. Your saves then stay on your Mac until you push a collection from its ⋯ menu, and the sidebar marks it **unsynced** in the meantime. **Settings** shows the calls you have left this month when Postman reports it.

Your data is stored in `~/Library/Application Support/app.dispatch.client/`. Requests go only to Postman's API and to the servers you send requests to.

## Not supported yet

- Live collaboration features: real-time co-editing, comments, forks and pull requests
- The collection runner, monitors, mock servers, flows, and API definitions
- WebSocket, gRPC, Socket.IO and MQTT requests
- OAuth 2.0 authorization code sign-in in a browser window (paste a token instead), and Digest, Hawk, AWS Signature, NTLM and Akamai auth
- Deleting whole collections or environments in Postman (do that in Postman; Dispatch picks it up on the next sync)
- Script libraries other than `chai`, `crypto-js`, `lodash`, `uuid` and `atob`/`btoa` (for example `moment`, `xml2js` or `cheerio`)
- Per-request client certificates and proxy settings

## Project layout

```
src/                 The interface (plain HTML, CSS and JavaScript modules; no build step)
  js/model.js        Postman Collection v2.1 helpers
  js/vars.js         Variable scopes and {{substitution}}
  js/scripts.js      The pm script sandbox
  js/send.js         Request pipeline: scripts, variables, auth, send, tests
  js/sync.js         Postman API calls
  js/store.js        App state, local storage, sync and conflict handling
  js/ui/             Sidebar, request editor, panels and shared components
  vendor/            chai, crypto-js and lodash (MIT licensed)
src-tauri/           The native shell in Rust
  src/http.rs        Sends requests
  src/postman.rs     Postman API client
  src/secrets.rs     Keychain storage for the API key
tests/               JavaScript tests for the core logic
```

Run the tests with `npm test` for the JavaScript and `cargo test` inside `src-tauri/` for Rust.

Opening `src/index.html` in a browser shows the interface running against a built-in demo account, which is useful for working on the UI without a Postman key.
