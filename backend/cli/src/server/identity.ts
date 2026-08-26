import { randomUUID } from "node:crypto"

export namespace ServerIdentity {
  export type Info = ReturnType<typeof fromEnv>

  function value(env: NodeJS.ProcessEnv, key: string) {
    const found = env[key]?.trim()
    return found || undefined
  }

  export function fromEnv(env: NodeJS.ProcessEnv, fallbackRunID = `local-${process.pid}-${randomUUID()}`) {
    return {
      sourceSha: value(env, "OPENSCIENCE_SOURCE_SHA") ?? null,
      sourceWorktreeHash: value(env, "OPENSCIENCE_SOURCE_WORKTREE_HASH") ?? null,
      runId: value(env, "OPENSCIENCE_RUN_ID") ?? fallbackRunID,
    }
  }

  // One process owns one identity for its lifetime. A caller can compare this
  // tuple across health checks and know whether it reached the same source
  // process rather than an older server left listening on the port.
  export const current = fromEnv(process.env)
}
