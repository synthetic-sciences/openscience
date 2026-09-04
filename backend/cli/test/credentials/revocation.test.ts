import { expect, test } from "bun:test"
import { CredentialRevocation } from "../../src/credentials/revocation"
import { MessageV2 } from "../../src/session/message-v2"

test("an expired synced overlay is overlay-scoped while other revisions keep their reach", () => {
  expect(CredentialRevocation.target("workspace-sync.expired")).toBe("overlay")
  expect(CredentialRevocation.scope("workspace-sync.expired")).toEqual({ overlay: true })
  for (const reason of [
    "workspace-sync.update",
    "workspace-sync.denied",
    "account.replace",
    "settings-credential.set:github",
  ]) {
    expect(CredentialRevocation.target(reason)).toBe("all")
    expect(CredentialRevocation.scope(reason)).toEqual({})
  }
  for (const reason of ["mcp-config.update", "mcp-auth.set:linear", "mcp-auth.tokens.refresh:linear"]) {
    expect(CredentialRevocation.target(reason)).toBe("mcp")
    expect(CredentialRevocation.scope(reason)).toEqual({})
  }
  expect(CredentialRevocation.target("mcp-auth.migrate")).toBe("none")
})

test("a revocation names its cause on the recorded turn error", () => {
  const expired = new CredentialRevocation.Interruption("workspace-sync.expired")
  expect(expired.message).toBe(CredentialRevocation.EXPIRED)
  expect(expired.reason).toBe("workspace-sync.expired")
  expect(CredentialRevocation.interruption(expired)).toBe(expired)
  expect(CredentialRevocation.interruption(new Error(CredentialRevocation.EXPIRED))).toBeUndefined()
  expect(CredentialRevocation.interruption(undefined)).toBeUndefined()

  const controller = new AbortController()
  controller.abort(expired)
  expect(CredentialRevocation.interruption(controller.signal.reason)?.message).toBe(CredentialRevocation.EXPIRED)

  const recorded = MessageV2.fromError(expired, { providerID: "openrouter" })
  expect(MessageV2.AbortedError.isInstance(recorded)).toBe(true)
  expect(recorded.data).toEqual({ message: CredentialRevocation.EXPIRED })

  const rotated = CredentialRevocation.message("workspace-sync.update")
  expect(rotated).toStartWith("Interrupted: credentials changed (workspace-sync.update)")
})

test("only the abort itself is attributed to the revocation that cancelled a turn", () => {
  const expired = new CredentialRevocation.Interruption("workspace-sync.expired")
  const unrelated = new Error("provider returned 500")
  const aborted = () => new DOMException("The operation was aborted", "AbortError")
  const controller = new AbortController()
  // Nothing is attributed while the controller is live.
  expect(CredentialRevocation.cancelled(unrelated, controller.signal)).toBeUndefined()
  expect(CredentialRevocation.cancelled(aborted(), controller.signal)).toBeUndefined()

  controller.abort(expired)
  // The reason itself (throwIfAborted) and the AbortError a cancelled request
  // surfaces are the revocation; an unrelated failure thrown afterwards is not.
  expect(CredentialRevocation.cancelled(expired, controller.signal)).toBe(expired)
  expect(CredentialRevocation.cancelled(aborted(), controller.signal)).toBe(expired)
  expect(CredentialRevocation.cancelled(unrelated, controller.signal)).toBeUndefined()

  // A user abort carries no revocation to attribute.
  const user = new AbortController()
  user.abort()
  expect(CredentialRevocation.cancelled(user.signal.reason, user.signal)).toBeUndefined()
})
