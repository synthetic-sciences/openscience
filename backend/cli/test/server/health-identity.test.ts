import { describe, expect, test } from "bun:test"
import { ServerIdentity } from "../../src/server/identity"

describe("server source identity", () => {
  test("uses exact dev-lab identity and a stable supplied local fallback", () => {
    expect(
      ServerIdentity.fromEnv(
        {
          OPENSCIENCE_SOURCE_SHA: "  commit-sha  ",
          OPENSCIENCE_SOURCE_WORKTREE_HASH: " worktree-hash ",
          OPENSCIENCE_RUN_ID: " process-run ",
        },
        "fallback",
      ),
    ).toEqual({ sourceSha: "commit-sha", sourceWorktreeHash: "worktree-hash", runId: "process-run" })
    expect(ServerIdentity.fromEnv({}, "local-fixed")).toEqual({
      sourceSha: null,
      sourceWorktreeHash: null,
      runId: "local-fixed",
    })
  })
})
