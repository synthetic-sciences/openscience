import { test, expect } from "bun:test"
import { waitForOAuthCallback } from "../../src/plugin/codex"

const pkce = { verifier: "verifier", challenge: "challenge" }

/** Settle within a window rather than awaiting a promise that a bug can leave
 * pending forever, so the failure reads as an assertion and not a hang. */
async function outcome(promise: Promise<unknown>, ms = 1_000) {
  return await Promise.race([
    promise.then(
      () => "resolved" as const,
      () => "rejected" as const,
    ),
    new Promise<"still-pending">((resolve) => setTimeout(() => resolve("still-pending"), ms)),
  ])
}

test("a sign-in attempt that is never answered times out", async () => {
  expect(await outcome(waitForOAuthCallback(pkce, "state-first", 10))).toBe("rejected")
})

test("a stale callback timer does not clear a newer sign-in attempt", async () => {
  // Abandoning the first attempt leaves its timer armed. The retry takes over
  // the callback slot, and the first timer then fires against an attempt it no
  // longer owns.
  const first = waitForOAuthCallback(pkce, "state-first", 10)
  const second = waitForOAuthCallback(pkce, "state-second", 10)

  expect(await outcome(first)).toBe("rejected")
  // The retry still owns the callback slot, so its own timer times it out
  // instead of finding the slot already gone and leaving it to hang.
  expect(await outcome(second)).toBe("rejected")
})
