// Local stand-ins for the Phase 7 engines, so a spec drives the REAL daemon + UI + drivers without a network or a key:
//   startFakeOpenAI({ key })  an OpenAI-compatible server: GET /v1/models (401 without the key), POST /v1/chat/completions
//                             (streamed; answers "Fake AI heard: <last user message>"). `seen` records every request.
//   fakeAcpAgent()            the path of the scripted ACP agent the driver tests use (answers `hello` with "Hello from <session>").
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));

export function fakeAcpAgent() {
  return path.resolve(HERE, "../../../packages/runtime/src/session/drivers/fixtures/fake-acp-agent.cjs");
}

export function startFakeOpenAI({ key = "sk-qa-123456", models = ["fake-small", "fake-large"] } = {}) {
  const seen = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      seen.push({ method: req.method, url: req.url, auth: req.headers.authorization ?? null, body });
      if (req.headers.authorization !== `Bearer ${key}`) {
        res.statusCode = 401;
        res.setHeader("content-type", "application/json");
        return res.end(JSON.stringify({ error: { message: "Incorrect API key provided" } }));
      }
      if (req.method === "GET" && req.url?.endsWith("/models")) {
        res.setHeader("content-type", "application/json");
        return res.end(JSON.stringify({ object: "list", data: models.map((id) => ({ id, object: "model" })) }));
      }
      if (req.method === "POST" && req.url?.endsWith("/chat/completions")) {
        let last = "";
        try {
          const j = JSON.parse(body);
          const m = (j.messages ?? []).toReversed().find((x) => x.role === "user");
          last = typeof m?.content === "string" ? m.content : JSON.stringify(m?.content ?? "");
        } catch {
          /* bad body */
        }
        const text = `Fake AI heard: ${last.replace(/\s+/g, " ").slice(-60)}`;
        res.setHeader("content-type", "text/event-stream");
        const chunk = (delta, finish = null) =>
          `data: ${JSON.stringify({ id: "c1", object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
        res.write(chunk({ role: "assistant", content: "" }));
        for (const w of text.match(/\S+\s*/g) ?? []) res.write(chunk({ content: w }));
        res.write(chunk({}, "stop"));
        res.write(`data: ${JSON.stringify({ id: "c1", object: "chat.completion.chunk", choices: [], usage: { prompt_tokens: 20, completion_tokens: 9, total_tokens: 29 } })}\n\n`);
        res.write("data: [DONE]\n\n");
        return res.end();
      }
      res.statusCode = 404;
      res.end("{}");
    });
  });
  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      resolve({ port, url: `http://127.0.0.1:${port}/v1`, key, seen, close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(() => r()); }) });
    }),
  );
}
