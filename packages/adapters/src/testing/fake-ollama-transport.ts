/**
 * Test-only fake of the Ollama Cloud endpoints, injected as pi-ai's `fetch` (M1-A3). No sockets,
 * no server, no network. Routes by URL path:
 *
 * - `…/api/tags`        → the LIVE model list fixture (`{ models: [{ name }] }`), which the port
 *                         treats as the only model truth (labelled `listed`);
 * - anything else       → OpenAI chat-completions streaming (SSE `chat.completion.chunk` frames),
 *                         a plain HTTP status error, or a stall-until-abort.
 *
 * The SSE frames are a synthetic fixture in the public OpenAI streaming format, not a recording of
 * a live Ollama response (no live calls are made in this repository). Every request is recorded so
 * tests can assert what would have reached the wire (auth header shape included).
 */

export type FakeOllamaRequest = {
  readonly method: string;
  readonly url: string;
  /** Lower-cased header names. */
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
};

export type FakeOllamaReply =
  /** Streams `chunks` as text deltas; `model` is what every chunk reports (→ responseModel). */
  | { readonly type: "stream"; readonly chunks: readonly string[]; readonly model: string }
  /** Streams chunks whose `model` field is omitted: the vendor reports no identity. */
  | { readonly type: "stream-no-model"; readonly chunks: readonly string[] }
  /** Plain HTTP error with a JSON body (tests use it for 429/502 quota signals). */
  | { readonly type: "status"; readonly status: number; readonly body: string }
  /** Sends the role frame + one delta, then stalls until the request is aborted. */
  | { readonly type: "hang"; readonly model: string };

export type FakeOllamaTransportOptions = {
  /** Model names served by the `/api/tags` route (the "live list" fixture). */
  readonly tags?: readonly string[];
  readonly reply?: FakeOllamaReply;
  /** Consumed in order before the sticky `reply` (429-then-success sequences). */
  readonly replies?: readonly FakeOllamaReply[];
};

export type FakeOllamaTransport = {
  readonly fetch: typeof globalThis.fetch;
  readonly requests: FakeOllamaRequest[];
  setReply(reply: FakeOllamaReply): void;
  queueReply(reply: FakeOllamaReply): void;
  /** Replace the `/api/tags` list at runtime (tests for catalog refresh). */
  setTags(tags: readonly string[]): void;
};

export const DEFAULT_FAKE_OLLAMA_TAGS: readonly string[] = Object.freeze(["gpt-oss-120b"]);

export const DEFAULT_FAKE_OLLAMA_REPLY: FakeOllamaReply = Object.freeze({
  type: "stream",
  chunks: Object.freeze(["Hello", " from", " fake", " Ollama"]),
  model: "gpt-oss-120b",
});

function chunkFrame(payload: Record<string, unknown>): string {
  return `data: ${JSON.stringify({ id: "chatcmpl-fake-1", object: "chat.completion.chunk", created: 1_700_000_000, ...payload })}\n\n`;
}

function roleFrame(model: string | null): string {
  return chunkFrame({
    ...(model === null ? {} : { model }),
    choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }],
  });
}

function deltaFrame(model: string | null, content: string): string {
  return chunkFrame({
    ...(model === null ? {} : { model }),
    choices: [{ index: 0, delta: { content }, finish_reason: null }],
  });
}

function endFrames(model: string | null): string {
  return (
    chunkFrame({
      ...(model === null ? {} : { model }),
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
    }) +
    chunkFrame({
      ...(model === null ? {} : { model }),
      choices: [],
      usage: { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 },
    }) +
    "data: [DONE]\n\n"
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

export function createFakeOllamaTransport(
  options: FakeOllamaTransportOptions = {},
): FakeOllamaTransport {
  const requests: FakeOllamaRequest[] = [];
  let reply = options.reply ?? DEFAULT_FAKE_OLLAMA_REPLY;
  const queue: FakeOllamaReply[] = [...(options.replies ?? [])];
  let tags = [...(options.tags ?? DEFAULT_FAKE_OLLAMA_TAGS)];
  const encoder = new TextEncoder();

  const fakeFetch = async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const request = input instanceof Request ? input : undefined;
    const url = request?.url ?? String(input);
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
      url,
      headers: recorded,
      body: await readBody(
        init?.body ?? (request === undefined ? undefined : await request.text()),
      ),
    });
    if (signal?.aborted) throw abortError();

    // The model-picker route: the "live" list, never a hard-coded truth in the port.
    if (new URL(url).pathname.endsWith("/api/tags")) {
      return new Response(
        JSON.stringify({
          models: tags.map((name) => ({
            name,
            model: name,
            modified_at: "2026-09-01T00:00:00Z",
            size: 1,
            digest: "fake-digest",
            details: { format: "gguf", family: "unknown" },
          })),
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }

    const current = queue.length > 0 ? (queue.shift() as FakeOllamaReply) : reply;
    if (current.type === "status") {
      return new Response(current.body, {
        status: current.status,
        headers: { "content-type": "application/json" },
      });
    }
    const model = current.type === "stream-no-model" ? null : current.model;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(roleFrame(model)));
        if (current.type === "hang") {
          controller.enqueue(encoder.encode(deltaFrame(model, "partial")));
          signal?.addEventListener("abort", () => controller.error(abortError()), { once: true });
          return;
        }
        for (const chunk of current.chunks) {
          controller.enqueue(encoder.encode(deltaFrame(model, chunk)));
        }
        controller.enqueue(encoder.encode(endFrames(model)));
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
    setTags: (next) => {
      tags = [...next];
    },
  };
}
