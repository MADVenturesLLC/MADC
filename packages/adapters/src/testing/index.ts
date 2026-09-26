/** Test helpers (not for production use): in-process fake of the Kimi Code endpoint. */

/** Test helpers (not for production use): fake `claude` child process (A5). */
export {
  createFakeClaudeSpawn,
  FAKE_CLAUDE_BINARY,
  FAKE_CLAUDE_ENTRY,
} from "./fake-claude-spawn.ts";
export {
  createFakeKimiTransport,
  DEFAULT_FAKE_REPLY,
  type FakeKimiReply,
  type FakeKimiRequest,
  type FakeKimiTransport,
} from "./fake-kimi-transport.ts";
