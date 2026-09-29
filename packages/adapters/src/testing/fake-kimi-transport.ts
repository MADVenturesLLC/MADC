/**
 * Test-only fake of the Kimi Code Anthropic-Messages endpoint, injected as pi-ai's `fetch`. No
 * sockets, no server (protocol pin §8.7 keeps server code out of M0 packages), no network. Every
 * request is recorded so tests can assert what would have reached the wire.
 *
 * The SSE frames are a synthetic fixture in the public Anthropic Messages streaming format, not a
 * recording of a live Kimi response (no live calls are made in this repository).
 */

export type FakeKimiRequest = {
  readonly method: string;
  readonly url: string;
  /** Lower-cased header names. */
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
};

export type FakeKimiReply =
  /** Streams `chunks` as text deltas; `model` is what `message_start` reports. */
  | { readonly type: "stream"; readonly chunks: readonly string[]; readonly model: string }
  /** Plain HTTP error with a JSON body (tests use it to echo hostile content back). */
  | { readonly type: "status"; readonly status: number; readonly body: string }
  /** Sends `message_start` + one delta, then stalls until the request is aborted. */
  | { readonly type: "hang"; readonly model: string };

export type FakeKimiTransport = {
  readonly fetch: typeof globalThis.fetch;
  readonly requests: FakeKimiRequest[];
  setReply(reply: FakeKimiReply): void;
  /**
   * Queue one reply ahead of the sticky reply (M1-A3: 429-then-success fallback sequences).
   * Additive — M0 tests only ever use `setReply`.
   */
  queueReply(reply: FakeKimiReply): void;
};

export const DEFAULT_FAKE_REPLY: FakeKimiReply = Object.freeze({
  type: "stream",
  chunks: Object.freeze(["Hello", " from", " fake", " Kimi"]),
  model: "kimi-for-coding",
});

function frame(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

function startFrames(model: string): string {
  return (
    frame("message_start", {
      type: "message_start",
      message: {
        id: "msg_fake_01",
        type: "message",
        role: "assistant",
        model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 7, output_tokens: 1 },
      },
    }) +
    frame("content_block_start", {
      type: "content_block_start",
      index: 0,
      content_block: { type: "text", text: "" },
    })
  );
}

function deltaFrame(text: string): string {
  return frame("content_block_delta", {
    type: "content_block_delta",
    index: 0,
    delta: { type: "text_delta", text },
  });
}

function endFrames(outputTokens: number): string {
  return (
    frame("content_block_stop", { type: "content_block_stop", index: 0 }) +
    frame("message_delta", {
      type: "message_delta",
      delta: { stop_reason: "end_turn", stop_sequence: null },
      usage: { output_tokens: outputTokens },
    }) +
    frame("message_stop", { type: "message_stop" })
  );
}

function abortError(): Error {
  const err = new Error("The operation was aborted.");
  err.name = "AbortError";
  return err;
}

async function readBody(body: unknown): Promise<string> {
  if (body === undefined || body === null) return "";
  if (typeof body === "string") return body;
  return await new Response(body as ConstructorParameters<typeof Response>[0]).text();
}

export function createFakeKimiTransport(
  initial: FakeKimiReply = DEFAULT_FAKE_REPLY,
): FakeKimiTransport {
  const requests: FakeKimiRequest[] = [];
  let reply = initial;
  const queue: FakeKimiReply[] = [];
  const encoder = new TextEncoder();

  const fakeFetch = async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const request = input instanceof Request ? input : undefined;
    const headers = new Headers(request?.headers);
    new Headers(init?.headers).forEach((value, name) => {
      headers.set(name, value);
    });
    const recorded: Record<string, string> = {};
    headers.forEach((value, name) => {
      recorded[name.toLowerCase()] = value;
    });
    const signal = init?.signal ?? request?.signal ?? undefined;
    requests.push({
      method: init?.method ?? request?.method ?? "GET",
      url: request?.url ?? String(input),
      headers: recorded,
      body: await readBody(
        init?.body ?? (request === undefined ? undefined : await request.text()),
      ),
    });
    if (signal?.aborted) throw abortError();

    const current = queue.length > 0 ? (queue.shift() as FakeKimiReply) : reply;
    if (current.type === "status") {
      return new Response(current.body, {
        status: current.status,
        headers: { "content-type": "application/json" },
      });
    }
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(startFrames(current.model)));
        if (current.type === "hang") {
          controller.enqueue(encoder.encode(deltaFrame("partial")));
          signal?.addEventListener("abort", () => controller.error(abortError()), { once: true });
          return;
        }
        for (const chunk of current.chunks) controller.enqueue(encoder.encode(deltaFrame(chunk)));
        controller.enqueue(encoder.encode(endFrames(current.chunks.length)));
        controller.close();
      },
    });
    return new Response(stream, {
      status: 200,
      headers: { "content-type": "text/event-stream", "cache-control": "no-cache" },
    });
  };

  return {
    fetch: fakeFetch as typeof globalThis.fetch,
    requests,
    setReply: (next) => {
      reply = next;
    },
    queueReply: (next) => {
      queue.push(next);
    },
  };
}
