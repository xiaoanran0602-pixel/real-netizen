// 本地假模型服务：记录每个请求，按 handler 决定回复。两种协议都支持流式与非流式。
import { createServer } from "node:http";
import { updateModelSecrets } from "../src/config/secrets.js";

/**
 * @param {(req: {url: string, headers: any, body: any}) => {status?: number, text?: string, raw?: string, delayMs?: number}} handler
 */
export async function startFakeModel(handler) {
  const requests = [];
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", async () => {
      const body = raw ? JSON.parse(raw) : {};
      const record = { url: req.url, headers: req.headers, body };
      requests.push(record);
      const result = (await handler(record)) ?? {};
      if (result.delayMs) await new Promise((resolve) => setTimeout(resolve, result.delayMs));
      if (result.status && result.status !== 200) {
        res.writeHead(result.status, { "content-type": "application/json" });
        res.end(result.raw ?? JSON.stringify({ error: { message: result.text ?? "bad" } }));
        return;
      }
      const text = result.text ?? "";
      const openai = req.url.includes("chat/completions");
      if (body.stream) {
        res.writeHead(200, { "content-type": "text/event-stream" });
        const pieces = text.match(/.{1,3}/gsu) ?? [];
        for (const piece of pieces) {
          if (openai) res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: piece } }] })}\n\n`);
          else res.write(`event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", delta: { type: "text_delta", text: piece } })}\n\n`);
        }
        res.end(openai ? "data: [DONE]\n\n" : `event: message_stop\ndata: {"type":"message_stop"}\n\n`);
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(openai ? { choices: [{ message: { content: text } }] } : { content: [{ type: "thinking", thinking: "…" }, { type: "text", text }] }));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  return { base, requests, close: () => new Promise((resolve) => server.close(resolve)) };
}

/** 把假服务写进当前 data 目录的 secrets/model.json。 */
export async function useFakeModel(handler, { protocol = "anthropic", suffix = "", chatModel = "chat-m", backgroundModel = "bg-m" } = {}) {
  const fake = await startFakeModel(handler);
  await updateModelSecrets({ protocol, baseUrl: `${fake.base}${suffix}`, apiKey: "sk-test-secret-1234", chatModel, backgroundModel });
  return fake;
}
