# QA stacks and specs

Each stack N (1..4) is an isolated daemon (own `KORA_HOME`, socket, UI port `8800+N*10`) plus a Vite dev server on
`5700+N*10`. Never `~/.kora`, never `:8797`.

```
KORA_QA_DIR=<scratch> node qa/stacks/stack.cjs up N          # seed (first time: `seed N`) + daemon + web
KORA_QA_DIR=<scratch> KORA_QA_BLOBS_STACK=N KORA_QA_CHROMIUM="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  node qa/e2e/20-blobs/browser.spec.mjs
node qa/stacks/stack.cjs down N
```

Use a private `KORA_QA_DIR` (and a free stack number: `lsof -iTCP:5710 -sTCP:LISTEN`) so you never share a stack, a
token or a port with another session. `KORA_MIN_FREE_GB=0.5` lowers the runtime suite's free-disk guard.

## Driving the blob browser's live view (Computer tab)

The live picture is a WebSocket, `/blob-browser/<blobId>/live?wsTicket=<single use>`, opened by the page itself
(`apps/web/.../browser/liveConnection.ts`: POST `/api/auth/websocket-ticket`, then the socket).

- The stack's Vite proxy forwards it: `DEV_PROXIED_PATH_PREFIXES` (`packages/shared/src/viteProxyPaths.ts`) lists
  `/blob-browser`, and `apps/web/vite.config.ts` sets `ws: true` for it, keeps the query string, and runs
  `authorizeDevProxy` (drops the same-origin `Origin`, adds the stack's UI token). A foreign Origin is still refused.
- A Vite server started BEFORE that change keeps the old proxy: the panel then sits on "Reconnecting" (Live QA #5). Restart
  it (`stack.cjs webstop N && stack.cjs web N`).
- The panel marks its socket state as `data-browser-panel[data-browser-connection="open|connecting|reconnecting|unavailable"]`;
  the picture is `[data-browser-canvas]` (a canvas that must not stay black).
- The engine (`chrome-headless-shell`, ~98 MB) must be installed (Settings > Kora, or the Computer tab's Set up);
  `browser.spec.mjs` asserts the live view reaches `open` with a drawn frame when it is. `browser-setup.spec.mjs` covers the
  install itself against a tiny local engine (no download).
- Any helper that proxies the daemon must do the same: `ws: true`, forward the path + query, and keep the Origin the
  daemon allows (`kora://` for the desktop app, the stack's own origin through Vite).
