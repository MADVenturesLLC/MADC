/**
 * Test-only fake of the Google Generative AI (Gemini) `streamGenerateContent` endpoint (M1-A4). No
 * sockets, no server, no network. Routes by URL path: a `…:streamGenerateContent` POST gets the
 * scripted reply, anything else a 404 (so an unexpected route fails loudly instead of silently
 * streaming).
 *
 * WHY THIS FAKE PATCHES `globalThis.fetch` INSTEAD OF EXPOSING A `fetch` PROPERTY
 *
 * Every other fake in this directory is injected through pi-ai's `fetch` stream option. The Gemini
 * lane cannot be: `node_modules/@earendil-works/pi-ai/dist/api/google-generative-ai.js` lines 36-37
 * read
 *
 * ```js
 * if (options?.fetch && options.fetch !== globalThis.fetch) {
 *     throw new Error("Custom fetch is not supported by the Google Generative AI adapter");
 * }
 * ```
 *
 * The `@google/genai` SDK calls the module-scope `fetch` (i.e. `globalThis.fetch`) itself, so the
 * only interception point is the global. Hence `createFakeGeminiTransport(...)` returns
 * `install()` / `restore()` instead of a `fetch` member, and `restore()` puts back the EXACT prior
 * value (including deleting the property again when there was none). Consequence for callers: a
 * `DirectKeyPortConfig` for this lane must NOT set `fetch` — omit it entirely, or set it to
 * `globalThis.fetch` read AFTER `install()`, which is then the same reference pi-ai compares
 * against and passes the guard.
 *
 * Wire facts this fake mirrors (pi-ai 0.87.1 + `@google/genai` 2.21.0): the request is
 * `POST {baseUrl}/models/{modelId}:streamGenerateContent?alt=sse`, and pi-ai's default Google
 * `baseUrl` is `https://generativelanguage.googleapis.com/v1beta` — it DOES include the version
 * path (the adapter sets `httpOptions.apiVersion = ""` so nothing is appended). Auth is
 * `x-goog-api-key: <key>`, NOT a Bearer header. The body is
 * `{"contents":[{"parts":[{"text":…}],"role":"user"}],"generationConfig":{…}}`. The response is
 * SSE `data: {…}` frames carrying `candidates[0].content.parts[].text`, `candidates[0].finishReason`
 * (`"STOP"`), `usageMetadata`, `responseId` and `modelVersion`. The SDK throws
 * `Incomplete JSON segment at the end` if the body does not end on a frame delimiter, so every
 * frame here is terminated with `\n\n`.
 *
 * pi-ai 0.87.1 limitations on this lane, stated so no test asserts what the wire cannot deliver:
 * - `google-generative-ai.js` NEVER assigns `output.responseModel` (in the whole pinned package
 *   only `api/openai-completions.js` and `api/anthropic-messages.js` do). The frames here still
 *   carry `modelVersion` because a real Gemini chunk does, but `AssistantMessage.responseModel`
 *   stays `undefined` for every reply kind — `stream` and `stream-no-model` are indistinguishable
 *   to pi-ai.
 * - the adapter also never calls `options.onResponse`, and `formatProviderError` on a
 *   `@google/genai` `ApiError` yields the JSON error body verbatim. So an HTTP status on this lane
 *   reaches `AssistantMessage.errorMessage` as `{"error":{"code":429,…}}`, NOT in the
 *   `"<status> <body>"` shape `leadingHttpStatus` parses. See the report that shipped with this
 *   file before wiring a quota signal for Gemini.
 *
 * The SSE frames are a synthetic fixture in the public Gemini streaming format, not a recording of
 * a live Google response (no live calls are made in this repository). Every request is recorded so
 * tests can assert what would have reached the wire (`x-goog-api-key` included).
 */

export type FakeGeminiRequest = {
  readonly method: string;
  readonly url: string;
  /** Lower-cased header names. */
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
};

export type FakeGeminiReply =
  /** Streams `chunks` as text parts; every frame carries `modelVersion` (inert — see module docs). */
  | { readonly type: "stream"; readonly chunks: readonly string[]; readonly model: string }
  /** Streams frames whose `modelVersion` field is omitted: the vendor reports no identity. */
  | { readonly type: "stream-no-model"; readonly chunks: readonly string[] }
  /**
   * Assistant answers with one tool call: a `parts[].functionCall` frame with
   * `finishReason: "STOP"`, which pi-ai turns into `stopReason: "toolUse"` plus a
   * `{ type: "toolCall", id, name, arguments }` content part (`arguments` is `args` verbatim).
   * `text`, when set, is streamed as a text part BEFORE the call.
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
  /** Sends one partial text frame, then stalls until the request is aborted. */
  | { readonly type: "hang"; readonly model: string };

export type FakeGeminiTransportOptions = {
  readonly reply?: FakeGeminiReply;
  /** Consumed in order before the sticky `reply` (two-request tool round-trips, 429-then-success). */
  readonly replies?: readonly FakeGeminiReply[];
};

export type FakeGeminiTransport = {
  readonly requests: FakeGeminiRequest[];
  /** Patch `globalThis.fetch`. Idempotent on the same instance. */
  install(): void;
  /** Put back the exact prior `globalThis.fetch` (deleting it when there was none). Idempotent. */
  restore(): void;
  setReply(reply: FakeGeminiReply): void;
  queueReply(reply: FakeGeminiReply): void;
};

export const DEFAULT_FAKE_GEMINI_REPLY: FakeGeminiReply = Object.freeze({
  type: "stream",
  chunks: Object.freeze(["Hello", " from", " fake", " Gemini"]),
  model: "gemini-2.5-flash",
});

/** A realistic Google error body; `code` tracks the HTTP status pi-ai's caller asked for. */
export function fakeGeminiErrorBody(status: number, message: string): string {
  return JSON.stringify({
    error: {
      code: status,
      message,
      status:
        status === 429 ? "RESOURCE_EXHAUSTED" : status === 401 ? "UNAUTHENTICATED" : "INTERNAL",
    },
  });
}

type GeminiFrame = {
  readonly parts: readonly Record<string, unknown>[];
  readonly finishReason?: string;
};

function dataFrame(payload: Record<string, unknown>): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

function candidateFrame(
  model: string | null,
  frame: GeminiFrame,
  usage: Record<string, unknown> | null,
): string {
  return dataFrame({
    ...(model === null ? {} : { modelVersion: model }),
    responseId: "fake-gemini-response-1",
    candidates: [
      {
        content: { parts: frame.parts, role: "model" },
        index: 0,
        ...(frame.finishReason === undefined ? {} : { finishReason: frame.finishReason }),
      },
    ],
    ...(usage === null ? {} : { usageMetadata: usage }),
  });
}

const USAGE = Object.freeze({
  promptTokenCount: 7,
  candidatesTokenCount: 3,
  totalTokenCount: 10,
});

function textFrame(text: string): GeminiFrame {
  return { parts: [{ text }] };
}

function toolCallFrame(reply: {
  readonly id: string;
  readonly name: string;
  readonly args: Readonly<Record<string, unknown>>;
}): GeminiFrame {
  return {
    parts: [{ functionCall: { id: reply.id, name: reply.name, args: reply.args } }],
    finishReason: "STOP",
  };
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

export function createFakeGeminiTransport(
  options: FakeGeminiTransportOptions = {},
): FakeGeminiTransport {
  const requests: FakeGeminiRequest[] = [];
  let reply = options.reply ?? DEFAULT_FAKE_GEMINI_REPLY;
  const queue: FakeGeminiReply[] = [...(options.replies ?? [])];
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

    if (!new URL(url).pathname.includes(":streamGenerateContent")) {
      return new Response(fakeGeminiErrorBody(404, "no fake route"), {
        status: 404,
        headers: { "content-type": "application/json" },
      });
    }

    const current = queue.length > 0 ? (queue.shift() as FakeGeminiReply) : reply;
    if (current.type === "status") {
      return new Response(current.body, {
        status: current.status,
        headers: { "content-type": "application/json" },
      });
    }
    const model = current.type === "stream-no-model" ? null : current.model;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        if (current.type === "hang") {
          controller.enqueue(encoder.encode(candidateFrame(model, textFrame("partial"), null)));
          signal?.addEventListener("abort", () => controller.error(abortError()), { once: true });
          return;
        }
        if (current.type === "tool-call") {
          if (current.text !== undefined) {
            controller.enqueue(
              encoder.encode(candidateFrame(model, textFrame(current.text), null)),
            );
          }
          controller.enqueue(
            encoder.encode(candidateFrame(model, toolCallFrame(current), { ...USAGE })),
          );
          controller.close();
          return;
        }
        for (const chunk of current.chunks) {
          controller.enqueue(encoder.encode(candidateFrame(model, textFrame(chunk), null)));
        }
        controller.enqueue(
          encoder.encode(candidateFrame(model, { parts: [], finishReason: "STOP" }, { ...USAGE })),
        );
        controller.close();
      },
    });
    return new Response(stream, {
      status: 200,
      headers: { "content-type": "text/event-stream", "cache-control": "no-cache" },
    });
  };

  let installed = false;
  let hadPriorFetch = false;
  let priorFetch: typeof globalThis.fetch | undefined;

  return {
    requests,
    install: () => {
      if (installed) return;
      hadPriorFetch = Reflect.has(globalThis, "fetch");
      priorFetch = globalThis.fetch;
      globalThis.fetch = fakeFetch as typeof globalThis.fetch;
      installed = true;
    },
    restore: () => {
      if (!installed) return;
      if (hadPriorFetch && priorFetch !== undefined) {
        globalThis.fetch = priorFetch;
      } else {
        Reflect.deleteProperty(globalThis, "fetch");
      }
      installed = false;
      priorFetch = undefined;
      hadPriorFetch = false;
    },
    setReply: (next) => {
      reply = next;
    },
    queueReply: (next) => {
      queue.push(next);
    },
  };
}
