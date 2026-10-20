# @kora/client-runtime

The desktop client's state and wire layer, kept free of React and of the DOM so it can be tested in Node.

- `wire`, `link`, `auth`, `host`: the WebSocket RPC connection to the local daemon (`127.0.0.1:8797`), its bearer
  token and reconnects.
- `store/*`: one module per domain (`threads`, `chat`, `fleet`, `swarm`, `terminal`, `projects`, `blobs`, …). Each
  exposes reducers and Effect atoms; the web app composes them.
- `worklog/*`: turns an agent's tool calls into the rows the transcript shows.
- Markdown and media helpers (`markdown-links`, `markdown-images`, `media-*`, `codex-*`) used when rendering replies.

Import the narrowest subpath (`@kora/client-runtime/store/threads`); there is no root export. Anything not listed in
`package.json` `exports` is internal.
