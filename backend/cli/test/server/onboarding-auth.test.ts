import { describe, expect, test } from "bun:test"
import type { Auth } from "../../src/auth"
import { OnboardingAuthRoutes, type OnboardingAuthDependencies } from "../../src/server/routes/onboarding-auth"

function setup(input: { credential?: Auth.Info; mode?: "managed" | "byok" | null; selectFailures?: number }) {
  let credential = input.credential
  let mode = input.mode ?? null
  let selectFailures = input.selectFailures ?? 0
  const events: string[] = []
  const dependencies: OnboardingAuthDependencies = {
    async readCredential() {
      events.push("read-credential")
      return credential
    },
    async saveCredential(_providerID, auth) {
      events.push(`save:${auth.type}`)
      credential = structuredClone(auth)
    },
    async removeCredential() {
      events.push("remove")
      credential = undefined
    },
    async readBillingMode() {
      events.push("read-mode")
      return mode
    },
    async selectByok() {
      events.push("select-byok")
      if (selectFailures > 0) {
        selectFailures--
        throw new Error("billing mode unavailable")
      }
      mode = "byok"
    },
    async restoreBillingMode(previous) {
      events.push(`restore-mode:${previous}`)
      mode = previous
    },
    invalidate() {
      events.push("invalidate")
    },
    async serialize(action) {
      events.push("lock")
      return action()
    },
  }
  const routes = OnboardingAuthRoutes(dependencies)
  const request = (providerID: string, key: string) =>
    routes.request(`/${providerID}/onboarding`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "api", key }),
    })
  return {
    events,
    request,
    state: () => ({ credential, mode }),
  }
}

describe("onboarding provider credential transaction", () => {
  test("removes a newly saved credential when selecting BYOK fails", async () => {
    const subject = setup({ mode: "managed", selectFailures: 1 })

    const response = await subject.request("anthropic", "sk-ant-new")

    expect(response.status).toBe(500)
    expect(await response.json()).toEqual({ error: "billing mode unavailable" })
    expect(subject.state()).toEqual({ credential: undefined, mode: "managed" })
    expect(subject.events).toEqual([
      "lock",
      "read-credential",
      "read-mode",
      "save:api",
      "select-byok",
      "remove",
      "restore-mode:managed",
      "invalidate",
    ])
  })

  test("restores the exact pre-existing credential after a later failure", async () => {
    const previous: Auth.Info = {
      type: "oauth",
      refresh: "refresh-before",
      access: "access-before",
      expires: 123,
      accountId: "account-before",
    }
    const subject = setup({ credential: previous, mode: null, selectFailures: 1 })

    const response = await subject.request("openai", "sk-openai-new")

    expect(response.status).toBe(500)
    expect(subject.state()).toEqual({ credential: previous, mode: null })
    expect(subject.events).toContain("save:oauth")
    expect(subject.events).not.toContain("remove")
  })

  test("a fresh route instance can retry the same key after compensated failure", async () => {
    const subject = setup({ credential: { type: "api", key: "sk-old" }, mode: "managed", selectFailures: 1 })
    expect((await subject.request("openrouter", "sk-new")).status).toBe(500)
    expect(subject.state()).toEqual({ credential: { type: "api", key: "sk-old" }, mode: "managed" })

    const response = await subject.request("openrouter", "sk-new")

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ configured: true })
    expect(subject.state()).toEqual({ credential: { type: "api", key: "sk-new" }, mode: "byok" })
  })
})
