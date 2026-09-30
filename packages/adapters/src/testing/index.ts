/** Test helpers (not for production use): in-process fake of the Kimi Code endpoint. */

/** Test helpers (not for production use): fake ACP vendor agent child process (M1-A6). */
export {
  createFakeAcpSpawn,
  FAKE_ACP_AGENT_ENTRY,
  FAKE_GROK_BINARY,
} from "./fake-acp-spawn.ts";
/** Test helpers (not for production use): fake `claude` child process (A5). */
export {
  createFakeClaudeSpawn,
  FAKE_CLAUDE_BINARY,
  FAKE_CLAUDE_ENTRY,
} from "./fake-claude-spawn.ts";
/** Test helpers (not for production use): fake `codex app-server` child process (A6). */
export {
  createFakeCodexSpawn,
  FAKE_CODEX_BINARY,
  FAKE_CODEX_ENTRY,
} from "./fake-codex-spawn.ts";
/** Test helpers (not for production use): fake DeepSeek chat-completions endpoint (M1-A4). */
export {
  createFakeDeepSeekTransport,
  DEFAULT_FAKE_DEEPSEEK_REPLY,
  type FakeDeepSeekReply,
  type FakeDeepSeekRequest,
  type FakeDeepSeekTransport,
  type FakeDeepSeekTransportOptions,
} from "./fake-deepseek-transport.ts";
/**
 * Test helpers (not for production use): fake Gemini `streamGenerateContent` endpoint (M1-A4).
 * Patches `globalThis.fetch` — see the module docs for why pi-ai's `fetch` option cannot be used.
 */
export {
  createFakeGeminiTransport,
  DEFAULT_FAKE_GEMINI_REPLY,
  type FakeGeminiReply,
  type FakeGeminiRequest,
  type FakeGeminiTransport,
  type FakeGeminiTransportOptions,
  fakeGeminiErrorBody,
} from "./fake-gemini-transport.ts";
export {
  createFakeKimiTransport,
  DEFAULT_FAKE_REPLY,
  type FakeKimiReply,
  type FakeKimiRequest,
  type FakeKimiTransport,
} from "./fake-kimi-transport.ts";
/** Test helpers (not for production use): fake Mistral chat-completions endpoint (M1-A4). */
export {
  createFakeMistralTransport,
  DEFAULT_FAKE_MISTRAL_REPLY,
  type FakeMistralReply,
  type FakeMistralRequest,
  type FakeMistralTransport,
  type FakeMistralTransportOptions,
} from "./fake-mistral-transport.ts";
/** Test helpers (not for production use): fake Ollama Cloud endpoints (M1-A3). */
export {
  createFakeOllamaTransport,
  DEFAULT_FAKE_OLLAMA_REPLY,
  DEFAULT_FAKE_OLLAMA_TAGS,
  type FakeOllamaReply,
  type FakeOllamaRequest,
  type FakeOllamaTransport,
  type FakeOllamaTransportOptions,
} from "./fake-ollama-transport.ts";
/** Test helpers (not for production use): fake xAI Grok Responses-API endpoint (M1-A4). */
export {
  createFakeXaiTransport,
  DEFAULT_FAKE_XAI_REPLY,
  FAKE_XAI_FUNCTION_ITEM_ID,
  FAKE_XAI_MESSAGE_ITEM_ID,
  type FakeXaiReply,
  type FakeXaiRequest,
  type FakeXaiTransport,
  type FakeXaiTransportOptions,
  fakeXaiToolCallId,
} from "./fake-xai-transport.ts";
