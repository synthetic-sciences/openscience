import { expect, test } from "bun:test"
import { credentialChange } from "./credential-change"

// The settings panels used to wrap the write and the refresh in one try/catch,
// so a refresh rejection — newly reachable: inflight-cache rejects any load
// after 30s and the catalog is megabytes — was reported as the credential
// operation failing, over a credential that had already been stored.

test("a successful write followed by a successful refresh reports nothing", async () => {
  const outcome = await credentialChange({
    write: async () => {},
    refresh: async () => {},
    done: "Signed in with ChatGPT",
  })

  expect(outcome).toEqual({ ok: true })
})

test("a refresh failure keeps the operation successful and says what actually happened", async () => {
  const outcome = await credentialChange({
    write: async () => {},
    refresh: async () => {
      throw new Error("load timed out after 30000ms")
    },
    done: "Signed in with ChatGPT",
  })

  // ok:true is the load-bearing half — the caller gates onConnected on it, and
  // gating it on the refresh is how a completed sign-in closed nothing and
  // rendered as a failure.
  expect(outcome.ok).toBe(true)
  expect(outcome.notice).toStartWith("Signed in with ChatGPT, but the model list could not be reloaded")
  expect(outcome.notice).toContain("load timed out after 30000ms")
})

test("a write failure is the operation failing, and the refresh is never attempted", async () => {
  let refreshed = 0
  const outcome = await credentialChange({
    write: async () => {
      throw new Error("callback rejected the code")
    },
    refresh: async () => {
      refreshed++
    },
    done: "Signed in with ChatGPT",
  })

  expect(outcome).toEqual({ ok: false, notice: "callback rejected the code" })
  expect(refreshed).toBe(0)
})

test("never rejects, whichever half failed", async () => {
  const boom = async () => {
    throw new Error("boom")
  }

  await expect(credentialChange({ write: boom, refresh: async () => {}, done: "Saved" })).resolves.toBeDefined()
  await expect(credentialChange({ write: async () => {}, refresh: boom, done: "Saved" })).resolves.toBeDefined()
})
