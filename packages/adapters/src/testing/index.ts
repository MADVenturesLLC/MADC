/** Test helpers (not for production use): in-process fake of the Kimi Code endpoint. */

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
export {
  createFakeKimiTransport,
  DEFAULT_FAKE_REPLY,
  type FakeKimiReply,
  type FakeKimiRequest,
  type FakeKimiTransport,
} from "./fake-kimi-transport.ts";
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
