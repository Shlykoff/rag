// components/chat/parse-sse.ts
//
// Minimal client-side Server-Sent Events parser for app/api/chat/route.ts's
// stream. `EventSource` can't be used here because it only supports GET
// requests with no body (see that route's own module comment) -- this
// reads `response.body` as a `ReadableStream<Uint8Array>` directly and
// splits on the `event:`/`data:` + blank-line-terminated SSE wire format
// (RFC 8895-ish, matching exactly what `formatSSE()` in the API route
// writes: `event: <type>\ndata: <json>\n\n`).

export interface RawSSEEvent {
  event: string;
  data: unknown;
}

export async function* parseSSEStream(
  body: ReadableStream<Uint8Array>
): AsyncGenerator<RawSSEEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (value) {
        buffer += decoder.decode(value, { stream: true });
      }
      if (done) {
        // Flush the decoder in case a multi-byte UTF-8 sequence was split
        // across chunks right at the very end of the stream.
        buffer += decoder.decode();
      }

      let separatorIndex = buffer.indexOf("\n\n");
      while (separatorIndex !== -1) {
        const rawEvent = buffer.slice(0, separatorIndex);
        buffer = buffer.slice(separatorIndex + 2);
        const parsed = parseOneEvent(rawEvent);
        if (parsed) yield parsed;
        separatorIndex = buffer.indexOf("\n\n");
      }

      if (done) break;
    }
  } finally {
    reader.releaseLock();
  }
}

function parseOneEvent(rawEvent: string): RawSSEEvent | null {
  let eventType = "message";
  const dataLines: string[] = [];
  for (const line of rawEvent.split("\n")) {
    if (line.startsWith("event:")) {
      eventType = line.slice("event:".length).trim();
    } else if (line.startsWith("data:")) {
      dataLines.push(line.slice("data:".length).trim());
    }
  }
  if (dataLines.length === 0) return null;
  try {
    return { event: eventType, data: JSON.parse(dataLines.join("\n")) };
  } catch {
    // A malformed/partial data payload should never crash the whole chat
    // UI -- drop just that one event.
    return null;
  }
}
