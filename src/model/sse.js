// ============================================================
// 通用 SSE 行解析：把 fetch 响应体按 "event:/data:" 拆成事件，供 Anthropic 与 OpenAI 两种流共用。
// ============================================================

/**
 * @param {ReadableStream<Uint8Array>} body
 * @returns {AsyncGenerator<{event: string, data: string}>}
 */
export async function* readSse(body) {
  const decoder = new TextDecoder();
  let buffer = "";
  let event = "";
  let data = [];
  const reader = body.getReader();
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let newline;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        let line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (line.endsWith("\r")) line = line.slice(0, -1);
        if (line === "") {
          if (data.length > 0) yield { event: event || "message", data: data.join("\n") };
          event = "";
          data = [];
          continue;
        }
        if (line.startsWith(":")) continue;
        const colon = line.indexOf(":");
        const field = colon < 0 ? line : line.slice(0, colon);
        let value = colon < 0 ? "" : line.slice(colon + 1);
        if (value.startsWith(" ")) value = value.slice(1);
        if (field === "event") event = value;
        else if (field === "data") data.push(value);
      }
    }
    buffer += decoder.decode();
    if (buffer.trim()) {
      for (const line of buffer.split(/\r?\n/u)) {
        if (line.startsWith("data:")) data.push(line.slice(5).trimStart());
        else if (line.startsWith("event:")) event = line.slice(6).trim();
      }
    }
    if (data.length > 0) yield { event: event || "message", data: data.join("\n") };
  } finally {
    reader.releaseLock();
  }
}
