/**
 * Test-only fake of the xAI Grok endpoint (OpenAI **Responses** API), injected as pi-ai's `fetch`
 * (M1-A4). No sockets, no server, no network. Routes by URL path: anything ending in `/responses`
 * gets the scripted reply, anything else a 404 (so an unexpected route fails loudly instead of
 * silently streaming).
 *
 * Wire facts this fake mirrors (pi-ai 0.87.1, `api/openai-responses.js` +
 * `api/openai-responses-shared.js` through the `openai` npm SDK): the request is
 * `POST {baseUrl}/v1/responses` — pi-ai's default xAI `baseUrl` is `https://api.x.ai/v1`, so a test
 * `baseUrl` should NOT add another `/v1`; auth is `authorization: Bearer <key>` plus the SDK's
 * `x-stainless-*` headers; the body is `{"model":…,"input":[{"role":"user","content":[{"type":
 * "input_text","text":…}]}],"stream":true,"store":false,…}`. The response is Responses-API SSE
 * (`event:` / `data:` pairs). pi-ai dispatches on the JSON `type` field of each `data` payload, and
 * the SDK throws `APIError` on any event whose TOP-LEVEL payload has a truthy `error` key, so no
 * frame here carries one.
 *
 * pi-ai 0.87.1 limitations on this lane, stated so no test asserts what the wire cannot deliver:
 * - `openai-responses-shared.js` NEVER assigns `output.responseModel` (in the whole pinned package
 *   only `api/openai-completions.js` and `api/anthropic-messages.js` do). `response.completed`'s
 *   `response.model` is not read by pi-ai at all. The frames here still carry `model` because a
 *   real xAI response does, but `AssistantMessage.responseModel` stays `undefined` for every reply
 *   kind — a served-model receipt on this lane cannot come from `responseModel`, and
 *   `stream` / `stream-no-model` are indistinguishable to pi-ai.
 * - the tool-call id pi-ai surfaces is the composite `"<call_id>|<item id>"`
 *   (`createSlot` in `openai-responses-shared.js`), NOT the bare `call_id`. Use
 *   {@link fakeXaiToolCallId} in assertions.
 *
 * The SSE frames are a synthetic fixture in the public OpenAI Responses streaming format, not a
 * recording of a live xAI response (no live calls are made in this repository). Every request is
 * recorded so tests can assert what would have reached the wire (auth header included).
 */

export type FakeXaiRequest = {
  readonly method: string;
  readonly url: string;
  /** Lower-cased header names. */
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
};

export type FakeXaiReply =
  /** Streams `chunks` as output-text deltas; every frame carries `model` (inert — see module docs). */
  | { readonly type: "stream"; readonly chunks: readonly string[]; readonly model: string }
  /** Streams frames whose `response.model` field is omitted: the vendor reports no identity. */
  | { readonly type: "stream-no-model"; readonly chunks: readonly string[] }
  /**
   * Assistant answers with one tool call: a `function_call` output item, which pi-ai turns into
   * `stopReason: "toolUse"` plus a `{ type: "toolCall", id, name, arguments }` content part whose
   * `id` is {@link fakeXaiToolCallId}`(callId, itemId)`. `text`, when set, is streamed as a message
   * item BEFORE the call.
   */
  | {
      readonly type: "tool-call";
      readonly callId: string;
      readonly itemId: string;
      readonly name: string;
      readonly args: Readonly<Record<string, unknown>>;
      readonly model: string;
      readonly text?: string;
    }
  /** Plain HTTP error with a JSON body (tests use it for 429/502 quota signals and 401). */
  | { readonly type: "status"; readonly status: number; readonly body: string }
  /** Sends `response.created` + one text delta, then stalls until the request is aborted. */
  | { readonly type: "hang"; readonly model: string };

export type FakeXaiTransportOptions = {
  readonly reply?: FakeXaiReply;
  /** Consumed in order before the sticky `reply` (two-request tool round-trips, 429-then-success). */
  readonly replies?: readonly FakeXaiReply[];
};

export type FakeXaiTransport = {
  readonly fetch: typeof globalThis.fetch;
  readonly requests: FakeXaiRequest[];
  setReply(reply: FakeXaiReply): void;
  queueReply(reply: FakeXaiReply): void;
};

export const DEFAULT_FAKE_XAI_REPLY: FakeXaiReply = Object.freeze({
  type: "stream",
  chunks: Object.freeze(["Hello", " from", " fake", " Grok"]),
  model: "grok-4.7",
});

export const FAKE_XAI_MESSAGE_ITEM_ID = "msg_fake_xai_0001";
export const FAKE_XAI_FUNCTION_ITEM_ID = "fc_fake_xai_0001";

/**
 * The tool-call id pi-ai's Responses parser produces for a `function_call` item:
 * `"<call_id>|<item id>"`. Replay splits it back on `"|"`.
 */
export function fakeXaiToolCallId(callId: string, itemId: string): string {
  return `${callId}|${itemId}`;
}

function event(type: string, data: Record<string, unknown>): string {
  return `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
}

function usage(): Record<string, unknown> {
  return {
    input_tokens: 7,
    input_tokens_details: { cached_tokens: 0 },
    output_tokens: 3,
    output_tokens_details: { reasoning_tokens: 0 },
    total_tokens: 10,
  };
}

function responseObject(
  model: string | null,
  status: string,
  output: readonly Record<string, unknown>[],
): Record<string, unknown> {
  return {
    id: "resp_fake_xai_0001",
    object: "response",
    created_at: 1_700_000_000,
    status,
    ...(model === null ? {} : { model }),
    error: null,
    incomplete_details: null,
    instructions: null,
    max_output_tokens: null,
    output,
    parallel_tool_calls: true,
    previous_response_id: null,
    reasoning: { effort: null, summary: null },
    store: false,
    temperature: 1,
    text: { format: { type: "text" } },
    tool_choice: "auto",
    tools: [],
    top_p: 1,
    truncation: "disabled",
    usage: usage(),
    user: null,
    metadata: {},
  };
}

function messageItem(text: string, status: string): Record<string, unknown> {
  return {
    type: "message",
    id: FAKE_XAI_MESSAGE_ITEM_ID,
    role: "assistant",
    status,
    content: [{ type: "output_text", text, annotations: [] }],
  };
}

function functionCallItem(
  callId: string,
  itemId: string,
  name: string,
  argsJson: string,
  status: string,
): Record<string, unknown> {
  return {
    type: "function_call",
    id: itemId,
    call_id: callId,
    name,
    arguments: argsJson,
    status,
  };
}

function createdFrames(model: string | null): string {
  const inProgress = responseObject(model, "in_progress", []);
  return (
    event("response.created", { response: inProgress, sequence_number: 0 }) +
    event("response.in_progress", { response: inProgress, sequence_number: 1 })
  );
}

function textFrames(model: string | null, chunks: readonly string[]): string {
  const added = event("response.output_item.added", {
    output_index: 0,
    item: messageItem("", "in_progress"),
  });
  const partAdded = event("response.content_part.added", {
    item_id: FAKE_XAI_MESSAGE_ITEM_ID,
    output_index: 0,
    content_index: 0,
    part: { type: "output_text", text: "", annotations: [] },
  });
  let full = "";
  let deltas = "";
  for (const chunk of chunks) {
    full += chunk;
    deltas += event("response.output_text.delta", {
      item_id: FAKE_XAI_MESSAGE_ITEM_ID,
      output_index: 0,
      content_index: 0,
      delta: chunk,
    });
  }
  const done =
    event("response.output_text.done", {
      item_id: FAKE_XAI_MESSAGE_ITEM_ID,
      output_index: 0,
      content_index: 0,
      text: full,
    }) +
    event("response.content_part.done", {
      item_id: FAKE_XAI_MESSAGE_ITEM_ID,
      output_index: 0,
      content_index: 0,
      part: { type: "output_text", text: full, annotations: [] },
    }) +
    event("response.output_item.done", {
      output_index: 0,
      item: messageItem(full, "completed"),
    });
  return (
    added +
    partAdded +
    deltas +
    done +
    event("response.completed", {
      response: responseObject(model, "completed", [messageItem(full, "completed")]),
    })
  );
}

function toolCallFrames(
  model: string | null,
  call: {
    readonly callId: string;
    readonly itemId: string;
    readonly name: string;
    readonly args: Readonly<Record<string, unknown>>;
  },
  leadingText: string | null,
): string {
  const argsJson = JSON.stringify(call.args);
  let offset = 0;
  let frames = "";
  if (leadingText !== null) {
    frames +=
      event("response.output_item.added", {
        output_index: offset,
        item: messageItem("", "in_progress"),
      }) +
      event("response.output_text.delta", {
        item_id: FAKE_XAI_MESSAGE_ITEM_ID,
        output_index: offset,
        content_index: 0,
        delta: leadingText,
      }) +
      event("response.output_item.done", {
        output_index: offset,
        item: messageItem(leadingText, "completed"),
      });
    offset += 1;
  }
  const output: Record<string, unknown>[] =
    leadingText === null ? [] : [messageItem(leadingText, "completed")];
  frames +=
    event("response.output_item.added", {
      output_index: offset,
      item: functionCallItem(call.callId, call.itemId, call.name, "", "in_progress"),
    }) +
    event("response.function_call_arguments.delta", {
      item_id: call.itemId,
      output_index: offset,
      delta: argsJson,
    }) +
    event("response.function_call_arguments.done", {
      item_id: call.itemId,
      output_index: offset,
      arguments: argsJson,
    }) +
    event("response.output_item.done", {
      output_index: offset,
      item: functionCallItem(call.callId, call.itemId, call.name, argsJson, "completed"),
    });
  output.push(functionCallItem(call.callId, call.itemId, call.name, argsJson, "completed"));
  return (
    frames + event("response.completed", { response: responseObject(model, "completed", output) })
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

export function createFakeXaiTransport(options: FakeXaiTransportOptions = {}): FakeXaiTransport {
  const requests: FakeXaiRequest[] = [];
  let reply = options.reply ?? DEFAULT_FAKE_XAI_REPLY;
  const queue: FakeXaiReply[] = [...(options.replies ?? [])];
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

    if (!new URL(url).pathname.endsWith("/responses")) {
      return new Response(JSON.stringify({ error: { message: "no fake route" } }), {
        status: 404,
        headers: { "content-type": "application/json" },
      });
    }

    const current = queue.length > 0 ? (queue.shift() as FakeXaiReply) : reply;
    if (current.type === "status") {
      return new Response(current.body, {
        status: current.status,
        headers: { "content-type": "application/json" },
      });
    }
    const model = current.type === "stream-no-model" ? null : current.model;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(createdFrames(model)));
        if (current.type === "hang") {
          controller.enqueue(
            encoder.encode(
              event("response.output_item.added", {
                output_index: 0,
                item: messageItem("", "in_progress"),
              }) +
                event("response.output_text.delta", {
                  item_id: FAKE_XAI_MESSAGE_ITEM_ID,
                  output_index: 0,
                  content_index: 0,
                  delta: "partial",
                }),
            ),
          );
          signal?.addEventListener("abort", () => controller.error(abortError()), { once: true });
          return;
        }
        if (current.type === "tool-call") {
          controller.enqueue(
            encoder.encode(
              toolCallFrames(
                model,
                {
                  callId: current.callId,
                  itemId: current.itemId,
                  name: current.name,
                  args: current.args,
                },
                current.text ?? null,
              ),
            ),
          );
          controller.close();
          return;
        }
        controller.enqueue(encoder.encode(textFrames(model, current.chunks)));
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
