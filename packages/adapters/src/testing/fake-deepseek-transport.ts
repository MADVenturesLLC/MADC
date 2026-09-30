/**
 * Test-only fake of the DeepSeek Chat Completions endpoint, injected as pi-ai's `fetch` (M1-A4).
 * No sockets, no server, no network. Routes by URL path: anything ending in `/chat/completions`
 * gets the scripted reply, anything else a 404 (so an unexpected route fails loudly instead of
 * silently streaming).
 *
 * Wire facts this fake mirrors (pi-ai 0.87.1, `api/openai-completions.js` through the `openai`
 * npm SDK): the request goes to `{baseUrl}/chat/completions` — pi-ai's default DeepSeek `baseUrl`
 * is `https://api.deepseek.com` with NO `/v1`, and a test `baseUrl` must match that shape; the
 * request carries `authorization: Bearer <key>` plus the SDK's `x-stainless-*` headers, and a body
 * of `{"model":…,"messages":[…],"stream":true,"stream_options":{"include_usage":true},
 * "thinking":{"type":"disabled"}}`. The response is OpenAI chat-completions SSE.
 *
 * `responseModel` on this lane (`api/openai-completions.js`, the ONLY pi-ai adapter besides
 * `anthropic-messages` that ever assigns it):
 *
 * ```js
 * if (typeof chunk.model === "string" && chunk.model.length > 0 && chunk.model !== model.id) {
 *     output.responseModel ||= chunk.model;
 * }
 * ```
 *
 * So a `stream` reply only surfaces a served model when its `model` DIFFERS from the requested
 * catalog id — pick a distinct identity (e.g. `deepseek-flash-0408` for a `deepseek-flash`
 * request). A frame whose `model` merely echoes the requested id leaves `responseModel` undefined,
 * exactly like `stream-no-model`.
 *
 * The SSE frames are a synthetic fixture in the public OpenAI streaming format, not a recording of
 * a live DeepSeek response (no live calls are made in this repository). Every request is recorded
 * so tests can assert what would have reached the wire (auth header included).
 */

export type FakeDeepSeekRequest = {
  readonly method: string;
  readonly url: string;
  /** Lower-cased header names. */
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
};

export type FakeDeepSeekReply =
  /** Streams `chunks` as text deltas; `model` is what every chunk reports (→ responseModel). */
  | { readonly type: "stream"; readonly chunks: readonly string[]; readonly model: string }
  /** Streams chunks whose `model` field is omitted: the vendor reports no identity. */
  | { readonly type: "stream-no-model"; readonly chunks: readonly string[] }
  /**
   * Assistant answers with one tool call (`finish_reason: "tool_calls"` → pi-ai `stopReason:
   * "toolUse"`). `text`, when set, is streamed as a text delta BEFORE the call. pi-ai yields a
   * `{ type: "toolCall", id, name, arguments }` content part with `id` verbatim.
   */
  | {
      readonly type: "tool-call";
      readonly id: string;
      readonly name: string;
      readonly args: Readonly<Record<string, unknown>>;
      readonly model: string;
      readonly text?: string;
    }
  /** Plain HTTP error with a JSON body (tests use it for 429/502 quota signals and 401). */
  | { readonly type: "status"; readonly status: number; readonly body: string }
  /** Sends the role frame + one delta, then stalls until the request is aborted. */
  | { readonly type: "hang"; readonly model: string };

export type FakeDeepSeekTransportOptions = {
  readonly reply?: FakeDeepSeekReply;
  /** Consumed in order before the sticky `reply` (two-request tool round-trips, 429-then-success). */
  readonly replies?: readonly FakeDeepSeekReply[];
};

export type FakeDeepSeekTransport = {
  readonly fetch: typeof globalThis.fetch;
  readonly requests: FakeDeepSeekRequest[];
  setReply(reply: FakeDeepSeekReply): void;
  queueReply(reply: FakeDeepSeekReply): void;
};

export const DEFAULT_FAKE_DEEPSEEK_REPLY: FakeDeepSeekReply = Object.freeze({
  type: "stream",
  chunks: Object.freeze(["Hello", " from", " fake", " DeepSeek"]),
  model: "deepseek-flash-0408",
});

function chunkFrame(payload: Record<string, unknown>): string {
  return `data: ${JSON.stringify({ id: "chatcmpl-fake-deepseek-1", object: "chat.completion.chunk", created: 1_700_000_000, ...payload })}\n\n`;
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

type FakeDeepSeekToolCall = {
  readonly id: string;
  readonly name: string;
  readonly args: Readonly<Record<string, unknown>>;
};

function toolCallFrame(model: string | null, call: FakeDeepSeekToolCall): string {
  return chunkFrame({
    ...(model === null ? {} : { model }),
    choices: [
      {
        index: 0,
        delta: {
          tool_calls: [
            {
              index: 0,
              id: call.id,
              type: "function",
              function: { name: call.name, arguments: JSON.stringify(call.args) },
            },
          ],
        },
        finish_reason: null,
      },
    ],
  });
}

function endFrames(model: string | null, finishReason: string): string {
  return (
    chunkFrame({
      ...(model === null ? {} : { model }),
      choices: [{ index: 0, delta: {}, finish_reason: finishReason }],
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

export function createFakeDeepSeekTransport(
  options: FakeDeepSeekTransportOptions = {},
): FakeDeepSeekTransport {
  const requests: FakeDeepSeekRequest[] = [];
  let reply = options.reply ?? DEFAULT_FAKE_DEEPSEEK_REPLY;
  const queue: FakeDeepSeekReply[] = [...(options.replies ?? [])];
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

    if (!new URL(url).pathname.endsWith("/chat/completions")) {
      return new Response(JSON.stringify({ error: { message: "no fake route" } }), {
        status: 404,
        headers: { "content-type": "application/json" },
      });
    }

    const current = queue.length > 0 ? (queue.shift() as FakeDeepSeekReply) : reply;
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
        if (current.type === "tool-call") {
          if (current.text !== undefined) {
            controller.enqueue(encoder.encode(deltaFrame(model, current.text)));
          }
          controller.enqueue(
            encoder.encode(
              toolCallFrame(model, { id: current.id, name: current.name, args: current.args }),
            ),
          );
          controller.enqueue(encoder.encode(endFrames(model, "tool_calls")));
          controller.close();
          return;
        }
        for (const chunk of current.chunks) {
          controller.enqueue(encoder.encode(deltaFrame(model, chunk)));
        }
        controller.enqueue(encoder.encode(endFrames(model, "stop")));
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
