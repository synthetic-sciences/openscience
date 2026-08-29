import { afterEach, describe, expect, spyOn, test } from "bun:test"
import { createHash } from "node:crypto"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { gunzipSync } from "node:zlib"
import { Global } from "../../src/global"
import { OpenScience } from "../../src/openscience"
import {
  CONSENT_VERSION,
  EVENT_TYPES,
  Event,
  OutboundTelemetry,
  coarsePlatform,
  telemetryIdentifier,
  telemetryDeletionProof,
  telemetryKeyID,
  telemetryKeyPrefix,
} from "../../src/telemetry/outbound"

const consent = path.join(Global.Path.data, "telemetry-consent-v2.json")
const queue = path.join(Global.Path.data, "telemetry-queue-v2.jsonl")
const dead = path.join(Global.Path.data, "telemetry-dead-letter-v2.jsonl")
const stateLease = path.join(Global.Path.data, "telemetry-state-v2.lock")
const legacyConsent = path.join(Global.Path.data, "telemetry-consent-v1.json")
const legacyQueue = path.join(Global.Path.data, "telemetry-queue-v1.jsonl")
const session = path.join(Global.Path.data, "openscience-session.json")
const auth = path.join(Global.Path.data, "auth.json")
const restores: Array<{ mockRestore(): void }> = []

async function signIn(user = "user_fixture", apiKey = "thk_fixture") {
  await Bun.write(session, JSON.stringify({ api_key: apiKey, user_id: user }))
}

afterEach(async () => {
  for (const restore of restores.splice(0)) restore.mockRestore()
  await Promise.all(
    [consent, queue, dead, stateLease, `${stateLease}.coord`, legacyConsent, legacyQueue, session, auth].map((file) =>
      fs.rm(file, { recursive: true, force: true }),
    ),
  )
})

describe("outbound OpenScience trace contract", () => {
  test("awaits terminal captures and drains telemetry before forced CLI exit", async () => {
    const [llm, processor, prompt, cli] = await Promise.all(
      ["llm.ts", "processor.ts", "prompt.ts", "../index.ts"].map((file) =>
        Bun.file(new URL(`../../src/session/${file}`, import.meta.url)).text(),
      ),
    )
    expect(llm).toContain("async onFinish(output)")
    expect(llm).toContain("await OutboundTelemetry.modelResponse")
    expect(processor).toContain("await OutboundTelemetry.assistantMessage")
    expect(prompt).toContain("await OutboundTelemetry.assistantMessage")
    expect(cli.indexOf("await OutboundTelemetry.initializeAccount")).toBeLessThan(
      cli.indexOf("await OpenScience.refreshIfStale"),
    )
    expect(cli.indexOf("await OutboundTelemetry.drain")).toBeLessThan(cli.lastIndexOf("process.exit()"))
  })

  test("accepts the v2 full-trajectory event union without a client account id", () => {
    const base = {
      event_id: crypto.randomUUID(),
      schema_version: 2 as const,
      occurred_at: new Date().toISOString(),
      trace_id: "a".repeat(32),
      span_id: "b".repeat(16),
      installation_id: crypto.randomUUID(),
      payload: { prompt: "complete content", nested: { result: [1, true, null] } },
    }
    for (const event_type of EVENT_TYPES) expect(Event.parse({ ...base, event_type }).event_type).toBe(event_type)
    expect(Event.safeParse({ ...base, event_type: "prompt_recorded" }).success).toBe(false)
    expect(Event.safeParse({ ...base, event_type: "user.message", account_id: "must_be_server_derived" }).success).toBe(
      false,
    )
  })

  test("records normalized usage for Ace and user-owned credential routes", async () => {
    await signIn("user_usage_routes")
    restores.push(spyOn(globalThis, "fetch").mockRejectedValue(new Error("offline")))
    await OutboundTelemetry.initializeAccount()
    for (const route of ["managed", "byok", "chatgpt", "subscription", "local"] as const) {
      expect(
        await OutboundTelemetry.modelUsage({
          sessionID: `ses_${route}`,
          messageID: `msg_${route}`,
          operationID: `step_${route}`,
          attempt: 1,
          route,
          provider: route === "managed" ? "openrouter" : "anthropic",
          model: "claude-sonnet-4-5",
          tokens: {
            input: 120,
            output: 30,
            reasoning: 8,
            cache: { read: 40, write: 5 },
          },
          cost: 0.001234,
        }),
      ).toBe(true)
    }
    const rows = (await Bun.file(queue).text())
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { event: unknown })
    const events = rows.map((row) => Event.parse(row.event)).filter((event) => event.event_type === "model.usage")
    expect(events).toHaveLength(5)
    expect(events.map((event) => event.model_route)).toEqual(["managed", "byok", "chatgpt", "subscription", "local"])
    expect(events[0]?.payload).toEqual({
      input_tokens: 120,
      output_tokens: 30,
      reasoning_tokens: 8,
      cache_read_tokens: 40,
      cache_write_tokens: 5,
      estimated_cost_microusd: 1234,
      cost_source: "model_catalog",
    })
  })

  test("keeps concurrent model and tool routes isolated by message", async () => {
    await signIn("user_route_lineage")
    restores.push(spyOn(globalThis, "fetch").mockRejectedValue(new Error("offline")))
    await OutboundTelemetry.initializeAccount()
    await OutboundTelemetry.modelRequest({
      sessionID: "ses_route_lineage",
      messageID: "msg_primary",
      attempt: 1,
      route: "local",
      provider: "ollama",
      model: "qwen",
      system: [],
      messages: [],
      tools: {},
      parameters: {},
    })
    await OutboundTelemetry.modelResponse({
      sessionID: "ses_route_lineage",
      messageID: "msg_title",
      attempt: 1,
      route: "custom",
      provider: "title-provider",
      model: "title-model",
      message: {},
      parts: [],
    })
    await OutboundTelemetry.tool({
      id: "prt_primary_tool",
      sessionID: "ses_route_lineage",
      messageID: "msg_primary",
      type: "tool",
      callID: "call_primary",
      tool: "write",
      state: {
        status: "completed",
        input: {},
        output: "done",
        title: "Write fixture",
        metadata: {},
        time: { start: 1, end: 2 },
      },
    })

    const events = (await Bun.file(queue).text())
      .trim()
      .split("\n")
      .map((line) => Event.parse((JSON.parse(line) as { event: unknown }).event))
    const tool = events.find((event) => event.event_type === "tool.completed")
    expect(tool).toMatchObject({
      run_id: "msg_primary",
      model_route: "local",
      provider_id: "ollama",
      model_id: "qwen",
    })
    await OutboundTelemetry.sessionCompleted({
      sessionID: "ses_route_lineage",
      messageID: "msg_primary",
      reason: "completed",
    })
    const completed = (await Bun.file(queue).text())
      .trim()
      .split("\n")
      .map((line) => Event.parse((JSON.parse(line) as { event: unknown }).event))
      .find((event) => event.event_type === "session.completed")
    expect(completed).toMatchObject({
      run_id: "msg_primary",
      model_route: "local",
      provider_id: "ollama",
      model_id: "qwen",
      parent_span_id: tool?.parent_span_id,
    })
  })

  test("retains project context, prompts, exposed reasoning, outputs, and tools for every remote route", async () => {
    await signIn("user_complete_remote_trajectories")
    restores.push(spyOn(globalThis, "fetch").mockRejectedValue(new Error("offline")))
    await OutboundTelemetry.initializeAccount()

    const routes = [
      { route: "managed", provider: "openrouter", model: "openai/gpt-5.6-sol" },
      { route: "byok", provider: "google", model: "gemini-3.6-flash" },
      { route: "chatgpt", provider: "openai", model: "gpt-5.6-codex" },
    ] as const
    for (const item of routes) {
      const sessionID = `ses_complete_${item.route}`
      const messageID = `msg_complete_${item.route}`
      await OutboundTelemetry.sessionStarted({
        sessionID,
        session: {
          id: sessionID,
          projectID: `project_${item.route}`,
          title: `Trajectory ${item.route}`,
          directory: `/research/${item.route}`,
        },
      })
      await OutboundTelemetry.userMessage({
        sessionID,
        messageID,
        route: item.route,
        provider: item.provider,
        model: item.model,
        message: { role: "user" },
        parts: [{ type: "text", text: `prompt content ${item.route}` }],
      })
      await OutboundTelemetry.modelRequest({
        sessionID,
        messageID,
        attempt: 1,
        route: item.route,
        provider: item.provider,
        model: item.model,
        system: [`Project: Trajectory ${item.route}`, `Project files: /research/${item.route}`],
        messages: [{ role: "user", content: `prompt content ${item.route}` }],
        tools: { research_search: { description: "Search research sources" } },
        parameters: { reasoningEffort: "high" },
      })
      await OutboundTelemetry.modelResponse({
        sessionID,
        messageID,
        attempt: 1,
        route: item.route,
        provider: item.provider,
        model: item.model,
        message: { role: "assistant", reasoningText: `exposed reasoning ${item.route}` },
        parts: [
          { type: "reasoning", text: `exposed reasoning ${item.route}` },
          { type: "text", text: `model output ${item.route}` },
        ],
        tokens: { inputTokens: 100, outputTokens: 25, reasoningTokens: 10 },
        finish: "stop",
      })
      await OutboundTelemetry.assistantMessage({
        sessionID,
        messageID,
        attempt: 1,
        route: item.route,
        provider: item.provider,
        model: item.model,
        message: { role: "assistant" },
        parts: [
          { type: "reasoning", text: `exposed reasoning ${item.route}` },
          { type: "text", text: `final output ${item.route}` },
        ],
      })
      await OutboundTelemetry.tool({
        id: `prt_complete_${item.route}`,
        sessionID,
        messageID,
        type: "tool",
        callID: `call_complete_${item.route}`,
        tool: "research_search",
        state: {
          status: "completed",
          input: { query: `research question ${item.route}` },
          output: `source result ${item.route}`,
          title: "Research search",
          metadata: {},
          time: { start: 1, end: 2 },
        },
      })
    }

    const events = (await Bun.file(queue).text())
      .trim()
      .split("\n")
      .map((line) => Event.parse((JSON.parse(line) as { event: unknown }).event))
    for (const item of routes) {
      const session = events.find(
        (event) =>
          event.event_type === "session.started" &&
          (event.payload.session as { title?: string } | undefined)?.title === `Trajectory ${item.route}`,
      )
      const routed = events.filter((event) => event.model_route === item.route)
      expect(session?.payload).toMatchObject({
        session: { projectID: `project_${item.route}`, directory: `/research/${item.route}` },
      })
      expect(routed.find((event) => event.event_type === "user.message")?.payload).toMatchObject({
        parts: [{ type: "text", text: `prompt content ${item.route}` }],
      })
      expect(routed.find((event) => event.event_type === "model.request")?.payload).toMatchObject({
        system: [`Project: Trajectory ${item.route}`, `Project files: /research/${item.route}`],
        messages: [{ role: "user", content: `prompt content ${item.route}` }],
      })
      expect(routed.find((event) => event.event_type === "model.response")?.payload).toMatchObject({
        parts: [
          { type: "reasoning", text: `exposed reasoning ${item.route}` },
          { type: "text", text: `model output ${item.route}` },
        ],
      })
      expect(routed.find((event) => event.event_type === "assistant.message")?.payload).toMatchObject({
        parts: [
          { type: "reasoning", text: `exposed reasoning ${item.route}` },
          { type: "text", text: `final output ${item.route}` },
        ],
      })
      expect(routed.find((event) => event.event_type === "search.completed")?.payload).toMatchObject({
        state: {
          input: { query: `research question ${item.route}` },
          output: `source result ${item.route}`,
        },
      })
    }
  })

  test("normalizes platform names and extracts only the non-secret key id", () => {
    expect(coarsePlatform("darwin")).toBe("macos")
    expect(coarsePlatform("win32")).toBe("windows")
    expect(coarsePlatform("linux")).toBe("linux")
    expect(coarsePlatform("freebsd")).toBe("unknown")
    const keyID = `thk_${"a".repeat(32)}`
    expect(telemetryKeyID(`${keyID}.${"secret".repeat(4)}`)).toBe(keyID)
    const organizationKeyID = `osk_${"b".repeat(32)}`
    expect(telemetryKeyID(`${organizationKeyID}.${"secret".repeat(4)}`)).toBe(organizationKeyID)
    expect(telemetryKeyID("thk_legacy-secret-without-an-id")).toBeUndefined()
    const rawKey = `${keyID}.${"secret".repeat(4)}`
    const epoch = "b".repeat(32)
    const nonce = "c".repeat(32)
    const proof = telemetryDeletionProof(rawKey, epoch, nonce)
    expect(telemetryKeyPrefix(rawKey)).toBe(`thk_${"a".repeat(8)}`)
    expect(telemetryKeyPrefix("thk_legacy.secret")).toBe("thk_legacy")
    expect(telemetryKeyPrefix(`osk_${"b".repeat(32)}.${"secret".repeat(4)}`)).toBe(`osk_${"b".repeat(8)}`)
    expect(telemetryKeyPrefix("osk_legacy.secret")).toBe("osk_legacy")
    expect(proof).toMatch(/^odp_v2\.[a-f0-9]{10,138}\.[a-f0-9]{32}\.[a-f0-9]{32}\.[a-f0-9]{64}$/)
    expect(proof).toBe(telemetryDeletionProof(rawKey, epoch, nonce))
    expect(proof).not.toBe(telemetryDeletionProof(rawKey, epoch, "d".repeat(32)))
    expect(proof).not.toContain(rawKey)
    expect(proof).not.toContain(createHash("sha256").update(rawKey).digest("hex"))

    expect(telemetryIdentifier("anthropic/claude-sonnet")).toBe("anthropic/claude-sonnet")
    const raw = "local provider label with opaque-secret"
    const canonical = telemetryIdentifier(raw)
    expect(canonical).toMatch(/^local:sha256:[a-f0-9]{64}$/)
    expect(canonical).not.toContain(raw)
  })

  test("isolates legacy pasted-key accounts and purges the previous account queue", async () => {
    restores.push(spyOn(globalThis, "fetch").mockRejectedValue(new Error("offline")))
    await Bun.write(session, JSON.stringify({ api_key: "thk_legacy_account_a.secret", user_id: "" }))
    await OutboundTelemetry.initializeAccount()
    await OutboundTelemetry.userMessage({
      sessionID: "ses_legacy_a",
      messageID: "msg_legacy_a",
      message: { role: "user" },
      parts: [{ text: "account-a-only" }],
    })
    const first = JSON.parse((await Bun.file(queue).text()).trim()) as { subject: string }
    expect(first.subject).toMatch(/^account:key-subject-v1:[a-f0-9]{64}$/)
    expect(first.subject).not.toContain("legacy_account_a_secret")

    await Bun.write(session, JSON.stringify({ api_key: "thk_legacy_account_b.secret", user_id: "" }))
    await OutboundTelemetry.initializeAccount()
    expect(await Bun.file(queue).exists()).toBe(false)
    await OutboundTelemetry.userMessage({
      sessionID: "ses_legacy_b",
      messageID: "msg_legacy_b",
      message: { role: "user" },
      parts: [{ text: "account-b-only" }],
    })
    const secondText = await Bun.file(queue).text()
    const second = JSON.parse(secondText.trim()) as { subject: string }
    expect(second.subject).toMatch(/^account:key-subject-v1:[a-f0-9]{64}$/)
    expect(second.subject).not.toBe(first.subject)
    expect(secondText).not.toContain("account-a-only")
  })

  test("requires an authenticated account before capture", async () => {
    expect(await OutboundTelemetry.status()).toMatchObject({
      analyticsEnabled: false,
      researchContentEnabled: false,
      signedIn: false,
    })
    expect(
      await OutboundTelemetry.userMessage({
        sessionID: "ses_signed_out",
        messageID: "msg_signed_out",
        message: { role: "user" },
        parts: [{ text: "private" }],
      }),
    ).toBe(false)
    expect(await Bun.file(queue).exists()).toBe(false)
  })

  test("honors an existing server opt-out before the first local capture or batch", async () => {
    await signIn("user_server_opt_out")
    let consentGets = 0
    let batches = 0
    restores.push(
      spyOn(globalThis, "fetch").mockImplementation((async (input, init) => {
        const url = String(input)
        if (url.endsWith("/api/v1/telemetry/consent")) {
          consentGets++
          expect(init?.method).toBe("GET")
          return Response.json({
            consent_version: CONSENT_VERSION,
            analytics_enabled: false,
            research_content_enabled: false,
            consent_epoch: "a".repeat(32),
          })
        }
        if (url.endsWith("/api/v1/telemetry/batches")) {
          batches++
          return Response.json({ detail: { code: "telemetry_consent_disabled", retryable: false } }, { status: 403 })
        }
        throw new Error(`Unexpected request: ${url}`)
      }) as typeof fetch),
    )

    await OutboundTelemetry.initializeAccount()
    expect(consentGets).toBe(1)
    expect(await OutboundTelemetry.status()).toMatchObject({
      analyticsEnabled: false,
      researchContentEnabled: false,
      pending: false,
    })
    expect(
      await OutboundTelemetry.userMessage({
        sessionID: "ses_server_opt_out",
        messageID: "msg_server_opt_out",
        message: { role: "user" },
        parts: [{ text: "must never leave this client" }],
      }),
    ).toBe(false)
    await OutboundTelemetry.drain({ timeoutMs: 1_000 })
    expect(batches).toBe(0)
    expect(await Bun.file(queue).exists()).toBe(false)
  })

  test("materializes fresh server consent once and skips redundant refreshes", async () => {
    await signIn("user_server_default")
    const epoch = "b".repeat(32)
    let consentGets = 0
    restores.push(
      spyOn(globalThis, "fetch").mockImplementation((async (input, init) => {
        expect(String(input)).toEndWith("/api/v1/telemetry/consent")
        expect(init?.method).toBe("GET")
        consentGets++
        return Response.json({
          consent_version: CONSENT_VERSION,
          analytics_enabled: true,
          research_content_enabled: true,
          consent_epoch: epoch,
        })
      }) as typeof fetch),
    )

    await OutboundTelemetry.initializeAccount()
    expect(consentGets).toBe(1)
    const first = JSON.parse(await Bun.file(consent).text()) as {
      subjects: Record<string, { consent_epoch?: string }>
    }
    expect(first.subjects["account:user_server_default"]?.consent_epoch).toBe(epoch)
    expect(await OutboundTelemetry.status()).toMatchObject({
      analyticsEnabled: true,
      researchContentEnabled: true,
      pending: false,
    })

    await OutboundTelemetry.initializeAccount()
    expect(consentGets).toBe(1)
  })

  test("defaults on after authentication, queues offline, and recursively redacts secrets", async () => {
    await signIn()
    const offline = spyOn(globalThis, "fetch").mockRejectedValue(new Error("offline"))
    restores.push(offline)
    await OutboundTelemetry.initializeAccount()
    expect(offline).toHaveBeenCalledTimes(1)
    expect(await OutboundTelemetry.status()).toMatchObject({
      analyticsEnabled: true,
      researchContentEnabled: true,
      signedIn: true,
      // New accounts inherit the disclosed server default. A local client
      // need not manufacture a consent write before it can queue offline.
      pending: false,
    })

    const secret = "sk-test-super-secret-value-1234567890"
    const privateKey = "-----BEGIN PRIVATE KEY-----\nsuper-secret-material\n-----END PRIVATE KEY-----"
    const deletionProofSuffix = createHash("sha256").update("telemetry-deletion-proof-suffix").digest("hex")
    const deletionProofPrefix = createHash("sha256").update("telemetry-key-prefix").digest("hex").slice(0, 10)
    const deletionProofEpoch = createHash("sha256").update("telemetry-epoch").digest("hex").slice(0, 32)
    const deletionProofNonce = createHash("sha256").update("telemetry-nonce").digest("hex").slice(0, 32)
    const deletionProof = `odp_v2.${deletionProofPrefix}.${deletionProofEpoch}.${deletionProofNonce}.${deletionProofSuffix}`
    // Reproduce the production ordering hazard: an independently registered
    // secret may be an exact substring of a structured credential. The whole
    // structured token must be removed before exact-value redaction runs.
    OpenScience.registerSecretValues([deletionProofSuffix])
    expect(
      await OutboundTelemetry.userMessage({
        sessionID: "ses_offline",
        messageID: "msg_offline",
        message: { role: "user", api_key: secret, private_key: privateKey },
        parts: [
          {
            text: `Use Authorization: Bearer ${secret}\n${privateKey}`,
            nested: {
              access_token: secret,
              deletion_proof: deletionProof,
              serialized_transport: JSON.stringify({
                capability: `x${deletionProof}x`,
                alternate: `_${deletionProof}_`,
              }),
              credentials: { refreshToken: secret },
            },
          },
        ],
      }),
    ).toBe(true)
    await Bun.sleep(5)
    const text = await Bun.file(queue).text()
    expect(text).toContain("[REDACTED]")
    expect(text).not.toContain(secret)
    expect(text).not.toContain(deletionProof)
    expect(text).toContain("serialized_transport")
    expect(text).toContain("capability")
    expect(text).toContain("x[REDACTED]x")
    expect(text).toContain("_[REDACTED]_")
    expect(text).not.toContain("super-secret-material")
    const row = JSON.parse(text.trim()) as { event: unknown }
    expect(Event.parse(row.event)).toMatchObject({ event_type: "user.message", schema_version: 2 })
  })

  test("appends queue rows in place and compacts only when the event cap is reached", async () => {
    await signIn("user_append_queue")
    restores.push(spyOn(globalThis, "fetch").mockRejectedValue(new Error("offline")))
    await OutboundTelemetry.initializeAccount()
    await OutboundTelemetry.userMessage({
      sessionID: "ses_append_queue",
      messageID: "msg_0",
      message: { role: "user" },
      parts: [{ text: "first" }],
    })
    const initial = await fs.stat(queue)
    for (let index = 1; index < 24; index++) {
      await OutboundTelemetry.userMessage({
        sessionID: "ses_append_queue",
        messageID: `msg_${index}`,
        message: { role: "user" },
        parts: [{ text: `event-${index}` }],
      })
    }
    const appended = await fs.stat(queue)
    expect(appended.ino).toBe(initial.ino)
    expect((await Bun.file(queue).text()).trim().split("\n")).toHaveLength(24)
    await OutboundTelemetry.drain({ timeoutMs: 1_000 })

    const template = JSON.parse((await Bun.file(queue).text()).trim().split("\n")[0]) as {
      subject: string
      queued_at: number
      event: Record<string, unknown>
    }
    const capped = Array.from({ length: 4096 }, (_, index) =>
      JSON.stringify({
        ...template,
        queued_at: template.queued_at + index,
        event: { ...template.event, event_id: crypto.randomUUID(), run_id: `seed_${index}` },
      }),
    )
    await Bun.write(queue, `${capped.join("\n")}\n`)
    await OutboundTelemetry.userMessage({
      sessionID: "ses_append_queue",
      messageID: "msg_after_cap",
      message: { role: "user" },
      parts: [{ text: "newest-event" }],
    })
    const compacted = (await Bun.file(queue).text())
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { event: { run_id?: string; payload?: unknown } })
    expect(compacted).toHaveLength(4096)
    expect(compacted.some((row) => row.event.run_id === "seed_0")).toBe(false)
    expect(JSON.stringify(compacted.at(-1)?.event.payload)).toContain("newest-event")
  })

  test("redacts opaque OAuth and well-known credentials plus bare credential fields", async () => {
    await signIn("user_opaque_auth")
    const secrets = {
      oauthAccess: "opaque-oauth-access-value-8dd8c48a",
      oauthRefresh: "opaque-oauth-refresh-value-c56317cf",
      wellknownKey: "opaque-wellknown-key-value-28fa1664",
      wellknownToken: "opaque-wellknown-token-value-532692e1",
      bareAccess: "unregistered-bare-access-value",
      bareRefresh: "unregistered-bare-refresh-value",
      bareKey: "unregistered-bare-key-value",
    }
    await Bun.write(
      auth,
      JSON.stringify({
        oauth: {
          type: "oauth",
          access: secrets.oauthAccess,
          refresh: secrets.oauthRefresh,
          expires: Date.now() + 60_000,
        },
        service: { type: "wellknown", key: secrets.wellknownKey, token: secrets.wellknownToken },
      }),
    )
    restores.push(spyOn(globalThis, "fetch").mockRejectedValue(new Error("offline")))
    await OutboundTelemetry.initializeAccount()
    await OutboundTelemetry.userMessage({
      sessionID: "ses_opaque_auth",
      messageID: "msg_opaque_auth",
      message: { role: "user" },
      parts: [
        {
          text: Object.values(secrets).slice(0, 4).join(" "),
          credentials: {
            access: secrets.bareAccess,
            refresh: secrets.bareRefresh,
            key: secrets.bareKey,
          },
        },
      ],
    })
    const stored = await Bun.file(queue).text()
    for (const secret of Object.values(secrets)) expect(stored).not.toContain(secret)
    expect(stored).toContain("[REDACTED]")
  })

  test("hashes invalid provider and model labels before queueing", async () => {
    await signIn("user_invalid_labels")
    restores.push(spyOn(globalThis, "fetch").mockRejectedValue(new Error("offline")))
    await OutboundTelemetry.initializeAccount()
    const provider = "local provider opaque-credential"
    const model = "model\nwith\tunsafe label"
    await OutboundTelemetry.modelRequest({
      sessionID: "ses_invalid_labels",
      messageID: "msg_invalid_labels",
      attempt: 1,
      route: "local",
      provider,
      model,
      system: [],
      messages: [],
      tools: {},
      parameters: {},
    })
    const stored = await Bun.file(queue).text()
    expect(stored).not.toContain(provider)
    expect(stored).not.toContain(model)
    const row = JSON.parse(stored.trim()) as { event: unknown }
    expect(Event.parse(row.event)).toMatchObject({
      provider_id: telemetryIdentifier(provider),
      model_id: telemetryIdentifier(model),
    })
  })

  test("links bounded model request, response, and error spans inside one session trace", async () => {
    await signIn("user_model_lineage")
    restores.push(spyOn(globalThis, "fetch").mockRejectedValue(new Error("offline")))
    await OutboundTelemetry.initializeAccount()

    const sessionID = "agent-config:ephemeral"
    const messageID = "agent-config-request:ephemeral"
    const secret = "sk-agent-config-super-secret-value-1234567890"
    await OutboundTelemetry.userMessage({
      sessionID,
      messageID,
      message: { role: "user", purpose: "agent_config_generation" },
      parts: [{ text: `Build a reviewer with Authorization: Bearer ${secret}` }],
    })
    await OutboundTelemetry.modelRequest({
      sessionID,
      messageID,
      attempt: 1,
      route: "managed",
      provider: "openrouter",
      model: "anthropic/claude-test",
      system: ["Generate a configuration"],
      messages: [{ role: "user", content: `credential=${secret}` }],
      tools: {},
      parameters: { purpose: "agent_config_generation", temperature: 0.3 },
    })
    await OutboundTelemetry.modelResponse({
      sessionID,
      messageID,
      attempt: 1,
      route: "managed",
      provider: "openrouter",
      model: "anthropic/claude-test",
      message: { role: "assistant", purpose: "agent_config_generation" },
      parts: [{ type: "json", value: { identifier: "reviewer", systemPrompt: `Never print ${secret}` } }],
      tokens: { inputTokens: 10, outputTokens: 5 },
      finish: "stop",
    })
    await OutboundTelemetry.error({
      sessionID,
      messageID,
      attempt: 1,
      parentSpanID: `${messageID}:model:1:request`,
      route: "managed",
      provider: "openrouter",
      model: "anthropic/claude-test",
      error: new Error(`provider rejected ${secret}`),
      context: { purpose: "agent_config_generation" },
    })

    const stored = await Bun.file(queue).text()
    expect(stored).not.toContain(secret)
    expect(stored).toContain("[REDACTED]")
    const events = stored
      .trim()
      .split("\n")
      .map((line) => Event.parse((JSON.parse(line) as { event: unknown }).event))
    const user = events.find((event) => event.event_type === "user.message")!
    const request = events.find((event) => event.event_type === "model.request")!
    const response = events.find((event) => event.event_type === "model.response")!
    const error = events.find((event) => event.event_type === "error")!

    expect(new Set(events.map((event) => event.trace_id))).toEqual(new Set([request.trace_id]))
    expect(new Set(events.map((event) => event.session_id))).toEqual(new Set([request.session_id]))
    expect(request).toMatchObject({
      parent_span_id: user.span_id,
      provider_id: "openrouter",
      model_id: "anthropic/claude-test",
      model_route: "managed",
    })
    expect(response.parent_span_id).toBe(request.span_id)
    expect(error.parent_span_id).toBe(request.span_id)
    expect(request.payload).toMatchObject({ parameters: { purpose: "agent_config_generation" } })
    expect(response.payload).toMatchObject({ parts: [{ type: "json" }] })
  })

  test("bounds the first traversal and redacts raw credential formats without losing ordinary trace text", async () => {
    await signIn("user_hostile_payload")
    restores.push(spyOn(globalThis, "fetch").mockRejectedValue(new Error("offline")))
    await OutboundTelemetry.initializeAccount()

    const wide: Record<string, unknown> = {}
    for (let index = 0; index < 512; index++) wide[`safe_${String(index).padStart(3, "0")}`] = "kept"
    Object.defineProperty(wide, "must_not_be_read", {
      enumerable: true,
      get() {
        throw new Error("the bounded first traversal read beyond its width limit")
      },
    })
    const awsID = `ASIA${"A".repeat(16)}`
    const awsSecret = "aBcD1234+/".repeat(4)
    const jwt = `${`eyJ${"a".repeat(12)}`}.${"b".repeat(12)}.${"c".repeat(12)}`
    const raw = [
      "ordinary research output remains visible",
      "postgresql://alice:database-password@db.example.internal/research",
      `aws_access_key_id = ${awsID}`,
      `aws_secret_access_key = ${awsSecret}`,
      "Cookie: session=browser-cookie-secret; csrf=csrf-secret",
      "Proxy-Authorization: Basic cHJveHk6c2VjcmV0",
      `token=${jwt}`,
      "TOTALLY_UNKNOWN_ENV=arbitrary-env-secret",
      "run env INLINE_UNKNOWN_ENV=inline-env-secret analyzer",
      "-----BEGIN CERTIFICATE-----\nprivate-pem-material\n-----END CERTIFICATE-----",
    ].join("\n")

    expect(
      await OutboundTelemetry.userMessage({
        sessionID: "ses_hostile_payload",
        messageID: "msg_hostile_payload",
        message: { role: "user" },
        parts: [{ text: raw, wide }],
      }),
    ).toBe(true)
    const stored = await Bun.file(queue).text()
    expect(stored).toContain("ordinary research output remains visible")
    expect(stored).toContain("db.example.internal/research")
    expect(stored).toContain("_openscience_omitted_fields")
    for (const secret of [
      "alice:database-password",
      awsID,
      awsSecret,
      "browser-cookie-secret",
      "csrf-secret",
      "cHJveHk6c2VjcmV0",
      jwt,
      "arbitrary-env-secret",
      "inline-env-secret",
      "private-pem-material",
    ]) {
      expect(stored).not.toContain(secret)
    }
  })

  test("uploads queued traces after reconnecting with mandatory bearer auth", async () => {
    await signIn("user_reconnect")
    const offline = spyOn(globalThis, "fetch").mockRejectedValue(new Error("offline"))
    restores.push(offline)
    await OutboundTelemetry.initializeAccount()
    await OutboundTelemetry.userMessage({
      sessionID: "ses_reconnect",
      messageID: "msg_reconnect",
      message: { role: "user" },
      parts: [{ text: "full prompt" }],
    })
    await Bun.sleep(5)
    offline.mockRestore()
    restores.pop()

    let envelope: Record<string, unknown> | undefined
    const online = spyOn(globalThis, "fetch").mockImplementation((async (input, init) => {
      const url = String(input)
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer thk_fixture")
      if (url.endsWith("/api/v1/telemetry/consent")) {
        return Response.json({
          consent_version: CONSENT_VERSION,
          analytics_enabled: true,
          research_content_enabled: true,
        })
      }
      if (url.endsWith("/api/v1/telemetry/batches")) {
        envelope = JSON.parse(gunzipSync(init?.body as Uint8Array).toString())
        const events = envelope?.events as Array<{ event_id: string }>
        return Response.json({ accepted: events.map((event) => event.event_id), replayed: [], rejected: [] })
      }
      throw new Error(`Unexpected request: ${url}`)
    }) as typeof fetch)
    restores.push(online)

    await OutboundTelemetry.flush()
    expect(envelope).toMatchObject({ schema_version: 2, consent_version: CONSENT_VERSION })
    expect(envelope).not.toHaveProperty("account_id")
    expect((envelope?.events as unknown[]).map((event) => Event.parse(event))).toHaveLength(1)
    expect(await Bun.file(queue).exists()).toBe(false)
  })

  test("does not hold the state lease while consent refresh is on the network", async () => {
    await signIn("user_slow_consent")
    await OutboundTelemetry.initializeAccount({ synchronize: false })
    const started = Promise.withResolvers<void>()
    const finish = Promise.withResolvers<void>()
    restores.push(
      spyOn(globalThis, "fetch").mockImplementation((async (input, init) => {
        const url = String(input)
        if (url.endsWith("/api/v1/telemetry/consent")) {
          expect(init?.method).toBe("GET")
          started.resolve()
          await finish.promise
          return Response.json({
            consent_version: CONSENT_VERSION,
            analytics_enabled: true,
            research_content_enabled: true,
          })
        }
        if (url.endsWith("/api/v1/telemetry/batches")) {
          const body = JSON.parse(gunzipSync(init?.body as Uint8Array).toString()) as {
            events: Array<{ event_id: string }>
          }
          return Response.json({ accepted: body.events.map((event) => event.event_id), replayed: [], rejected: [] })
        }
        throw new Error(`Unexpected request: ${url}`)
      }) as typeof fetch),
    )

    const refreshing = OutboundTelemetry.status(true)
    await started.promise
    const appending = OutboundTelemetry.userMessage({
      sessionID: "ses_slow_consent",
      messageID: "msg_during_consent",
      message: { role: "user" },
      parts: [{ text: "capture while consent refresh waits" }],
    })
    expect(await Promise.race([appending, Bun.sleep(500).then(() => "timed-out" as const)])).toBe(true)
    finish.resolve()
    expect(await refreshing).toMatchObject({ analyticsEnabled: true, researchContentEnabled: true })
    await OutboundTelemetry.drain({ timeoutMs: 1_000 })
  })

  test("schedules one follow-up pass when an event is appended during an active upload", async () => {
    await signIn("user_slow_batch_append")
    await OutboundTelemetry.initializeAccount({ synchronize: false })

    const started = Promise.withResolvers<void>()
    const finish = Promise.withResolvers<void>()
    const followedUp = Promise.withResolvers<void>()
    const uploaded: string[] = []
    let requests = 0
    restores.push(
      spyOn(globalThis, "fetch").mockImplementation((async (input, init) => {
        expect(String(input)).toEndWith("/api/v1/telemetry/batches")
        const body = JSON.parse(gunzipSync(init?.body as Uint8Array).toString()) as {
          events: Array<{ event_id: string }>
        }
        requests++
        if (requests === 1) {
          started.resolve()
          await finish.promise
        }
        if (requests === 2) followedUp.resolve()
        uploaded.push(...body.events.map((event) => event.event_id))
        return Response.json({ accepted: body.events.map((event) => event.event_id), replayed: [], rejected: [] })
      }) as typeof fetch),
    )

    expect(
      await OutboundTelemetry.userMessage({
        sessionID: "ses_slow_batch_append",
        messageID: "msg_before_upload",
        message: { role: "user" },
        parts: [{ text: "selected before network" }],
      }),
    ).toBe(true)
    await started.promise
    const appending = OutboundTelemetry.userMessage({
      sessionID: "ses_slow_batch_append",
      messageID: "msg_during_upload",
      message: { role: "user" },
      parts: [{ text: "appended during network" }],
    })
    expect(await Promise.race([appending, Bun.sleep(500).then(() => "timed-out" as const)])).toBe(true)
    expect((await Bun.file(queue).text()).trim().split("\n")).toHaveLength(2)
    finish.resolve()
    expect(await Promise.race([followedUp.promise.then(() => true), Bun.sleep(1_000).then(() => false)])).toBe(true)
    for (let attempt = 0; attempt < 100 && (await Bun.file(queue).exists()); attempt++) await Bun.sleep(10)
    expect(await Bun.file(queue).exists()).toBe(false)
    await Bun.sleep(30)
    expect(requests).toBe(2)
    expect(new Set(uploaded).size).toBe(2)
  })

  test("coalesces concurrent consent refreshes after waiting for the network lease", async () => {
    await signIn("user_concurrent_consent")
    await OutboundTelemetry.initializeAccount({ synchronize: false })
    const started = Promise.withResolvers<void>()
    const finish = Promise.withResolvers<void>()
    let requests = 0
    restores.push(
      spyOn(globalThis, "fetch").mockImplementation((async (input, init) => {
        expect(String(input)).toEndWith("/api/v1/telemetry/consent")
        expect(init?.method).toBe("GET")
        requests++
        started.resolve()
        await finish.promise
        return Response.json({
          consent_version: CONSENT_VERSION,
          analytics_enabled: true,
          research_content_enabled: true,
        })
      }) as typeof fetch),
    )

    const first = OutboundTelemetry.status(true)
    const second = OutboundTelemetry.status(true)
    await started.promise
    // Let the second caller take its pre-lock snapshot and block behind the
    // first request before that request is allowed to commit a new generation.
    await Bun.sleep(20)
    finish.resolve()
    const statuses = await Promise.all([first, second])

    expect(statuses).toEqual([
      expect.objectContaining({ analyticsEnabled: true, researchContentEnabled: true }),
      expect.objectContaining({ analyticsEnabled: true, researchContentEnabled: true }),
    ])
    expect(requests).toBe(1)
  })

  test("does not acknowledge a batch after its consent generation changes", async () => {
    await signIn("user_generation_guard")
    const offline = spyOn(globalThis, "fetch").mockRejectedValue(new Error("offline"))
    restores.push(offline)
    await OutboundTelemetry.initializeAccount()
    await OutboundTelemetry.userMessage({
      sessionID: "ses_generation_guard",
      messageID: "msg_generation_guard",
      message: { role: "user" },
      parts: [{ text: "must survive a stale acknowledgement" }],
    })
    await OutboundTelemetry.drain({ timeoutMs: 1_000 })
    offline.mockRestore()
    restores.pop()

    const started = Promise.withResolvers<void>()
    const finish = Promise.withResolvers<void>()
    restores.push(
      spyOn(globalThis, "fetch").mockImplementation((async (_input, init) => {
        started.resolve()
        await finish.promise
        const body = JSON.parse(gunzipSync(init?.body as Uint8Array).toString()) as {
          events: Array<{ event_id: string }>
        }
        return Response.json({ accepted: body.events.map((event) => event.event_id), replayed: [], rejected: [] })
      }) as typeof fetch),
    )

    const flushing = OutboundTelemetry.flush()
    await started.promise
    const state = JSON.parse(await Bun.file(consent).text()) as {
      subjects: Record<string, { generation?: string }>
    }
    state.subjects["account:user_generation_guard"].generation = "f".repeat(32)
    await Bun.write(consent, JSON.stringify(state, null, 2))
    finish.resolve()
    await flushing

    expect(await Bun.file(queue).exists()).toBe(true)
    expect(await Bun.file(queue).text()).toContain("must survive a stale acknowledgement")
  })

  test("finishes an in-flight batch before replacing its account credential", async () => {
    const accountA = { api_key: "thk_upload_account_a.secret", user_id: "upload-account-a" }
    const accountB = { api_key: "thk_upload_account_b.secret", user_id: "upload-account-b" }
    await signIn(accountA.user_id, accountA.api_key)
    const offline = spyOn(globalThis, "fetch").mockRejectedValue(new Error("offline"))
    restores.push(offline)
    await OutboundTelemetry.initializeAccount()
    await OutboundTelemetry.userMessage({
      sessionID: "ses_upload_replacement",
      messageID: "msg_upload_replacement",
      message: { role: "user" },
      parts: [{ text: "belongs only to account A" }],
    })
    await OutboundTelemetry.drain({ timeoutMs: 1_000 })
    offline.mockRestore()
    restores.pop()

    const started = Promise.withResolvers<void>()
    const finish = Promise.withResolvers<void>()
    const authorizations: Array<string | null> = []
    restores.push(
      spyOn(globalThis, "fetch").mockImplementation((async (input, init) => {
        expect(String(input)).toEndWith("/api/v1/telemetry/batches")
        authorizations.push(new Headers(init?.headers).get("authorization"))
        started.resolve()
        await finish.promise
        const body = JSON.parse(gunzipSync(init?.body as Uint8Array).toString()) as {
          events: Array<{ event_id: string }>
        }
        return Response.json({ accepted: body.events.map((event) => event.event_id), replayed: [], rejected: [] })
      }) as typeof fetch),
    )

    const flushing = OutboundTelemetry.flush()
    await started.promise
    let replaced = false
    const replacement = OpenScience.saveSession(accountB).finally(() => {
      replaced = true
    })
    await Bun.sleep(30)
    expect(replaced).toBe(false)
    expect(await OpenScience.getSession()).toMatchObject(accountA)

    finish.resolve()
    await flushing
    await replacement
    expect(authorizations).toEqual([`Bearer ${accountA.api_key}`])
    expect(await OpenScience.getSession()).toMatchObject(accountB)
    expect(await Bun.file(queue).exists()).toBe(false)
  })

  test("drain waits for fire-and-forget final capture and uploads it", async () => {
    await signIn("user_final_drain")
    await OutboundTelemetry.initializeAccount({ synchronize: false })
    const scrubStarted = Promise.withResolvers<void>()
    const finishScrub = Promise.withResolvers<void>()
    const originalScrub = OpenScience.scrubSecrets
    restores.push(
      spyOn(OpenScience, "scrubSecrets").mockImplementation((async (value: unknown) => {
        scrubStarted.resolve()
        await finishScrub.promise
        return originalScrub(value)
      }) as typeof OpenScience.scrubSecrets),
    )
    const uploaded: Array<{ event_type: string; payload: unknown }> = []
    restores.push(
      spyOn(globalThis, "fetch").mockImplementation((async (input, init) => {
        if (!String(input).endsWith("/api/v1/telemetry/batches")) {
          throw new Error(`Unexpected request: ${String(input)}`)
        }
        const body = JSON.parse(gunzipSync(init?.body as Uint8Array).toString()) as {
          events: Array<{ event_id: string; event_type: string; payload: unknown }>
        }
        uploaded.push(...body.events)
        return Response.json({
          accepted: body.events.map((event) => event.event_id),
          replayed: [],
          rejected: [],
        })
      }) as typeof fetch),
    )

    const recording = OutboundTelemetry.modelResponse({
      sessionID: "ses_final_drain",
      messageID: "msg_final_drain",
      attempt: 1,
      route: "managed",
      provider: "openrouter",
      model: "openai/gpt-test",
      message: { role: "assistant" },
      parts: [{ type: "text", text: "final response" }],
      finish: "stop",
    })
    await scrubStarted.promise
    let drainSettled = false
    // Keep the runtime deadline contract, but leave enough wall-clock room for
    // the loaded Linux CI runner to settle the deliberately paused capture and
    // perform its bounded upload. The separate slow-upload test proves the
    // deadline itself remains enforced.
    const draining = OutboundTelemetry.drain({ timeoutMs: 5_000 }).finally(() => {
      drainSettled = true
    })
    await Bun.sleep(20)
    expect(drainSettled).toBe(false)

    finishScrub.resolve()
    expect(await recording).toBe(true)
    expect(await draining).toEqual({ captured: true, flushed: true, timedOut: false, pendingEvents: 0 })
    expect(uploaded).toHaveLength(1)
    expect(uploaded[0]).toMatchObject({ event_type: "model.response" })
    expect(JSON.stringify(uploaded[0].payload)).toContain("final response")
  })

  test("drain stops at its deadline when an upload is slow", async () => {
    await signIn("user_bounded_drain")
    await OutboundTelemetry.initializeAccount({ synchronize: false })
    const uploadStarted = Promise.withResolvers<void>()
    const finishUpload = Promise.withResolvers<void>()
    restores.push(
      spyOn(globalThis, "fetch").mockImplementation((async (input, init) => {
        if (!String(input).endsWith("/api/v1/telemetry/batches")) {
          throw new Error(`Unexpected request: ${String(input)}`)
        }
        uploadStarted.resolve()
        await finishUpload.promise
        const body = JSON.parse(gunzipSync(init?.body as Uint8Array).toString()) as {
          events: Array<{ event_id: string }>
        }
        return Response.json({
          accepted: body.events.map((event) => event.event_id),
          replayed: [],
          rejected: [],
        })
      }) as typeof fetch),
    )
    await OutboundTelemetry.modelResponse({
      sessionID: "ses_bounded_drain",
      messageID: "msg_bounded_drain",
      attempt: 1,
      route: "managed",
      provider: "openrouter",
      model: "openai/gpt-test",
      message: { role: "assistant" },
      parts: [],
    })
    await uploadStarted.promise

    const startedAt = Date.now()
    const result = await OutboundTelemetry.drain({ timeoutMs: 40 })
    expect(result.timedOut).toBe(true)
    expect(Date.now() - startedAt).toBeLessThan(500)
    finishUpload.resolve()
    expect(await OutboundTelemetry.drain({ timeoutMs: 1_000 })).toMatchObject({ flushed: true, pendingEvents: 0 })
  })

  test("bounds huge content and drops legacy oversize rows without blocking later traces", async () => {
    await signIn("user_large_trace")
    const offline = spyOn(globalThis, "fetch").mockRejectedValue(new Error("offline"))
    restores.push(offline)
    await OutboundTelemetry.initializeAccount()
    const secret = "sk-test-large-secret-value-1234567890"
    await OutboundTelemetry.userMessage({
      sessionID: "ses_large",
      messageID: "msg_large",
      message: { role: "user" },
      parts: [{ text: "x".repeat(5 * 1024 * 1024), nested: { Authorization: `Bearer ${secret}` } }],
    })
    await Bun.sleep(5)

    const boundedRow = JSON.parse((await Bun.file(queue).text()).trim()) as {
      subject: string
      queued_at: number
      event: Record<string, unknown> & { event_id: string; payload: Record<string, unknown> }
    }
    expect(Buffer.byteLength(JSON.stringify(boundedRow.event))).toBeLessThan(600 * 1024)
    expect(JSON.stringify(boundedRow.event.payload)).toContain("[truncated]")
    expect(JSON.stringify(boundedRow)).not.toContain(secret)

    // Simulate a row written by an older client that had no per-event bound.
    // Flush must discard it and still deliver the valid event behind it.
    const legacyOversize = {
      ...boundedRow,
      queued_at: boundedRow.queued_at - 1,
      event: {
        ...boundedRow.event,
        event_id: crypto.randomUUID(),
        payload: { output: "y".repeat(4 * 1024 * 1024 + 1024) },
      },
    }
    await Bun.write(queue, `${JSON.stringify(legacyOversize)}\n${JSON.stringify(boundedRow)}\n`)

    offline.mockRestore()
    restores.pop()
    let uploaded: Array<{ event_id: string }> = []
    restores.push(
      spyOn(globalThis, "fetch").mockImplementation((async (input, init) => {
        if (String(input).endsWith("/api/v1/telemetry/consent")) {
          return Response.json({
            consent_version: CONSENT_VERSION,
            analytics_enabled: true,
            research_content_enabled: true,
          })
        }
        if (String(input).endsWith("/api/v1/telemetry/batches")) {
          const body = JSON.parse(gunzipSync(init?.body as Uint8Array).toString()) as {
            events: Array<{ event_id: string }>
          }
          uploaded = body.events
          return Response.json({ accepted: uploaded.map((event) => event.event_id), replayed: [], rejected: [] })
        }
        throw new Error(`Unexpected request: ${String(input)}`)
      }) as typeof fetch),
    )

    await OutboundTelemetry.flush()
    expect(uploaded.map((event) => event.event_id)).toEqual([boundedRow.event.event_id])
    expect(await Bun.file(queue).exists()).toBe(false)
  })

  test("quarantines a permanently rejected event so valid later rows still upload", async () => {
    await signIn("user_rejected_trace")
    const offline = spyOn(globalThis, "fetch").mockRejectedValue(new Error("offline"))
    restores.push(offline)
    await OutboundTelemetry.initializeAccount()
    await OutboundTelemetry.userMessage({
      sessionID: "ses_rejected_trace",
      messageID: "msg_rejected",
      message: { role: "user" },
      parts: [{ text: "server-reject-this-event" }],
    })
    await OutboundTelemetry.userMessage({
      sessionID: "ses_rejected_trace",
      messageID: "msg_valid",
      message: { role: "user" },
      parts: [{ text: "deliver-this-valid-event" }],
    })
    await Bun.sleep(5)
    offline.mockRestore()
    restores.pop()

    const attempts: string[][] = []
    const accepted: string[] = []
    restores.push(
      spyOn(globalThis, "fetch").mockImplementation((async (input, init) => {
        if (String(input).endsWith("/api/v1/telemetry/consent")) {
          return Response.json({
            consent_version: CONSENT_VERSION,
            analytics_enabled: true,
            research_content_enabled: true,
          })
        }
        const body = JSON.parse(gunzipSync(init?.body as Uint8Array).toString()) as {
          events: Array<{ event_id: string; payload: unknown }>
        }
        attempts.push(body.events.map((event) => event.event_id))
        if (body.events.some((event) => JSON.stringify(event.payload).includes("server-reject-this-event"))) {
          return Response.json({ detail: { code: "telemetry_schema_rejected" } }, { status: 422 })
        }
        accepted.push(...body.events.map((event) => event.event_id))
        return Response.json({ accepted: body.events.map((event) => event.event_id), replayed: [], rejected: [] })
      }) as typeof fetch),
    )

    await OutboundTelemetry.flush()
    expect(attempts.map((ids) => ids.length)).toEqual([2, 1, 1])
    expect(accepted).toHaveLength(1)
    expect(await Bun.file(queue).exists()).toBe(false)
    const quarantined = JSON.parse((await Bun.file(dead).text()).trim()) as {
      status: number
      reason: string
      event: { payload: unknown }
    }
    expect(quarantined.status).toBe(422)
    expect(quarantined.reason).toContain("telemetry_schema_rejected")
    expect(JSON.stringify(quarantined.event.payload)).toContain("server-reject-this-event")
    expect(await OutboundTelemetry.status()).toMatchObject({ queuedEvents: 0, quarantinedEvents: 1 })
  })

  test("keeps Ace traces while user-owned route logging is disabled", async () => {
    await signIn("user_owned_opt_out")
    restores.push(spyOn(globalThis, "fetch").mockRejectedValue(new Error("offline")))
    await OutboundTelemetry.initializeAccount()

    await OutboundTelemetry.userMessage({
      sessionID: "ses_managed_before",
      messageID: "msg_managed_before",
      route: "managed",
      provider: "openrouter",
      model: "anthropic/claude-sonnet-4.5",
      message: { role: "user" },
      parts: [{ text: "ace-before" }],
    })
    await OutboundTelemetry.userMessage({
      sessionID: "ses_byok_before",
      messageID: "msg_byok_before",
      route: "byok",
      provider: "anthropic",
      model: "claude-sonnet-4.5",
      message: { role: "user" },
      parts: [{ text: "byok-before" }],
    })

    expect(await OutboundTelemetry.setUserOwned(false)).toMatchObject({
      analyticsEnabled: true,
      userOwnedContentEnabled: false,
    })
    for (const value of ["byok", "chatgpt", "subscription", "local", "custom"] as const) {
      expect(
        await OutboundTelemetry.userMessage({
          sessionID: `ses_${value}_after`,
          messageID: `msg_${value}_after`,
          route: value,
          provider: value,
          model: "fixture-model",
          message: { role: "user" },
          parts: [{ text: `${value}-must-stay-local` }],
        }),
      ).toBe(false)
    }
    expect(
      await OutboundTelemetry.userMessage({
        sessionID: "ses_managed_after",
        messageID: "msg_managed_after",
        route: "managed",
        provider: "openrouter",
        model: "anthropic/claude-sonnet-4.5",
        message: { role: "user" },
        parts: [{ text: "ace-after" }],
      }),
    ).toBe(true)

    const text = await Bun.file(queue).text()
    expect(text).toContain("ace-before")
    expect(text).toContain("ace-after")
    expect(text).not.toContain("byok-before")
    expect(text).not.toContain("must-stay-local")
  })

  test("recovers from a server-side user-owned opt-out without losing Ace traces", async () => {
    await signIn("user_owned_server_opt_out")
    const offline = spyOn(globalThis, "fetch").mockRejectedValue(new Error("offline"))
    restores.push(offline)
    await OutboundTelemetry.initializeAccount()
    await OutboundTelemetry.userMessage({
      sessionID: "ses_server_managed",
      messageID: "msg_server_managed",
      route: "managed",
      provider: "openrouter",
      model: "openai/gpt-test",
      message: { role: "user" },
      parts: [{ text: "ace-server-kept" }],
    })
    await OutboundTelemetry.userMessage({
      sessionID: "ses_server_byok",
      messageID: "msg_server_byok",
      route: "byok",
      provider: "anthropic",
      model: "claude-test",
      message: { role: "user" },
      parts: [{ text: "byok-server-dropped" }],
    })
    await Bun.sleep(5)
    offline.mockRestore()
    restores.pop()

    const batches: string[][] = []
    restores.push(
      spyOn(globalThis, "fetch").mockImplementation((async (input, init) => {
        if (String(input).endsWith("/api/v1/telemetry/consent")) {
          return Response.json({
            consent_version: CONSENT_VERSION,
            analytics_enabled: true,
            research_content_enabled: true,
            user_owned_content_enabled: true,
          })
        }
        const body = JSON.parse(gunzipSync(init?.body as Uint8Array).toString()) as {
          events: Array<{ event_id: string; model_route?: string }>
        }
        batches.push(body.events.map((event) => event.model_route ?? "unknown"))
        if (body.events.some((event) => event.model_route !== "managed")) {
          return Response.json(
            { detail: { code: "user_owned_telemetry_consent_disabled", retryable: false } },
            { status: 403 },
          )
        }
        return Response.json({ accepted: body.events.map((event) => event.event_id), replayed: [] })
      }) as typeof fetch),
    )

    await OutboundTelemetry.flush()
    expect(batches).toEqual([["managed", "byok"], ["managed"]])
    expect(await OutboundTelemetry.status()).toMatchObject({
      analyticsEnabled: true,
      userOwnedContentEnabled: false,
      queuedEvents: 0,
    })
    expect(await Bun.file(queue).exists()).toBe(false)
  })

  test("turning data use off drops unsent traces and prevents new capture", async () => {
    await signIn("user_opt_out")
    restores.push(spyOn(globalThis, "fetch").mockRejectedValue(new Error("offline")))
    await OutboundTelemetry.initializeAccount()
    await OutboundTelemetry.userMessage({
      sessionID: "ses_opt_out",
      messageID: "msg_before",
      message: { role: "user" },
      parts: [{ text: "queued" }],
    })
    expect(await Bun.file(queue).exists()).toBe(true)
    expect(await OutboundTelemetry.setAnalytics(false)).toMatchObject({
      analyticsEnabled: false,
      researchContentEnabled: false,
    })
    expect(await Bun.file(queue).exists()).toBe(false)
    expect(
      await OutboundTelemetry.userMessage({
        sessionID: "ses_opt_out",
        messageID: "msg_after",
        message: { role: "user" },
        parts: [{ text: "must stay local" }],
      }),
    ).toBe(false)
  })

  test("turning data use off waits for the authenticated server preference", async () => {
    await signIn("user_opt_out_server_purge")
    await OutboundTelemetry.initializeAccount({ synchronize: false })
    const requestStarted = Promise.withResolvers<void>()
    const finishRequest = Promise.withResolvers<void>()
    let requested: Record<string, unknown> | undefined
    restores.push(
      spyOn(globalThis, "fetch").mockImplementation((async (input, init) => {
        expect(String(input)).toEndWith("/api/v1/telemetry/consent")
        expect(init?.method).toBe("PUT")
        expect(new Headers(init?.headers).get("authorization")).toBe("Bearer thk_fixture")
        requested = JSON.parse(String(init?.body)) as Record<string, unknown>
        requestStarted.resolve()
        await finishRequest.promise
        return Response.json({
          consent_version: CONSENT_VERSION,
          analytics_enabled: false,
          research_content_enabled: false,
        })
      }) as typeof fetch),
    )

    let settled = false
    const disabling = OutboundTelemetry.setAnalytics(false).finally(() => {
      settled = true
    })
    await requestStarted.promise
    await Bun.sleep(20)
    expect(settled).toBe(false)
    expect(requested).toMatchObject({
      consent_version: CONSENT_VERSION,
      analytics_enabled: false,
      research_content_enabled: false,
    })

    finishRequest.resolve()
    expect(await disabling).toMatchObject({
      analyticsEnabled: false,
      researchContentEnabled: false,
      pending: false,
    })
  })

  test("disabled flush retries an offline opt-out before its early return", async () => {
    await signIn("user_disabled_flush_retry")
    await OutboundTelemetry.initializeAccount({ synchronize: false })
    const offline = spyOn(globalThis, "fetch").mockRejectedValue(new Error("offline"))
    restores.push(offline)
    expect(await OutboundTelemetry.setAnalytics(false)).toMatchObject({
      analyticsEnabled: false,
      pending: true,
    })
    offline.mockRestore()
    restores.pop()

    const requests: Array<{ authorization: string | null; body: Record<string, unknown> }> = []
    restores.push(
      spyOn(globalThis, "fetch").mockImplementation((async (_input, init) => {
        requests.push({
          authorization: new Headers(init?.headers).get("authorization"),
          body: JSON.parse(String(init?.body)) as Record<string, unknown>,
        })
        return Response.json({
          consent_version: CONSENT_VERSION,
          analytics_enabled: false,
          research_content_enabled: false,
        })
      }) as typeof fetch),
    )

    await OutboundTelemetry.flush()
    expect(requests).toHaveLength(1)
    expect(requests[0]).toMatchObject({
      authorization: "Bearer thk_fixture",
      body: { analytics_enabled: false, research_content_enabled: false },
    })
    expect(await OutboundTelemetry.status()).toMatchObject({ analyticsEnabled: false, pending: false })
  })

  test("account initialization retries a persisted offline opt-out after restart", async () => {
    await signIn("user_restart_retry")
    await OutboundTelemetry.initializeAccount({ synchronize: false })
    const offline = spyOn(globalThis, "fetch").mockRejectedValue(new Error("offline"))
    restores.push(offline)
    expect(await OutboundTelemetry.setAnalytics(false)).toMatchObject({ pending: true })
    offline.mockRestore()
    restores.pop()

    let optOuts = 0
    restores.push(
      spyOn(globalThis, "fetch").mockImplementation((async (_input, init) => {
        optOuts++
        expect(new Headers(init?.headers).get("authorization")).toBe("Bearer thk_fixture")
        return Response.json({
          consent_version: CONSENT_VERSION,
          analytics_enabled: false,
          research_content_enabled: false,
        })
      }) as typeof fetch),
    )

    await OutboundTelemetry.initializeAccount()
    expect(optOuts).toBe(1)
    expect(await OutboundTelemetry.status()).toMatchObject({ analyticsEnabled: false, pending: false })
  })

  test("signed-out startup never turns a prospective opt-out into deletion", async () => {
    const apiKey = `thk_${"a".repeat(32)}.${"device-secret".repeat(3)}`
    await signIn("proof-account", apiKey)
    await OutboundTelemetry.initializeAccount({ synchronize: false })
    const offline = spyOn(globalThis, "fetch").mockRejectedValue(new TypeError("offline"))
    restores.push(offline)
    expect(await OutboundTelemetry.setAnalytics(false)).toMatchObject({ pending: true })

    // Neither a reusable verifier, raw credential, nor deletion authority is
    // written for a prospective collection opt-out.
    // codeql[js/insufficient-password-hash]
    const rawHash = createHash("sha256").update(apiKey).digest("hex")
    const beforeLogout = await Bun.file(consent).text()
    expect(beforeLogout).not.toContain(apiKey)
    expect(beforeLogout).not.toContain(rawHash)
    expect(beforeLogout).not.toContain("deletion_proof")
    await OpenScience.clearSession()
    expect(await OpenScience.getSession()).toBeNull()

    offline.mockRestore()
    restores.pop()
    const requests: string[] = []
    restores.push(
      spyOn(globalThis, "fetch").mockImplementation((async (input: Parameters<typeof fetch>[0]) => {
        requests.push(String(input))
        throw new Error(`Unexpected signed-out request: ${input}`)
      }) as unknown as typeof fetch),
    )

    await OutboundTelemetry.initializeAccount()
    expect(requests).toEqual([])
    const afterRetry = await Bun.file(consent).text()
    expect(afterRetry).not.toContain(apiKey)
    expect(afterRetry).not.toContain(rawHash)
    expect(afterRetry).not.toContain("deletion_proof")
    expect(JSON.parse(afterRetry).subjects["account:proof-account"]).toMatchObject({ pending: true })
  })

  test("opt-out serializes behind an in-flight upload and prevents every later upload", async () => {
    await signIn("user_opt_out_upload")
    const batchStarted = Promise.withResolvers<void>()
    const finishBatch = Promise.withResolvers<void>()
    let batchUploads = 0
    restores.push(
      spyOn(globalThis, "fetch").mockImplementation((async (input, init) => {
        const url = String(input)
        if (url.endsWith("/api/v1/telemetry/consent")) {
          const requested = init?.body ? (JSON.parse(String(init.body)) as Record<string, boolean>) : undefined
          return Response.json({
            consent_version: CONSENT_VERSION,
            analytics_enabled: requested?.analytics_enabled ?? true,
            research_content_enabled: requested?.research_content_enabled ?? true,
          })
        }
        if (url.endsWith("/api/v1/telemetry/batches")) {
          batchUploads++
          batchStarted.resolve()
          await finishBatch.promise
          const body = JSON.parse(gunzipSync(init?.body as Uint8Array).toString()) as {
            events: Array<{ event_id: string }>
          }
          return Response.json({ accepted: body.events.map((event) => event.event_id), replayed: [], rejected: [] })
        }
        throw new Error(`Unexpected request: ${url}`)
      }) as typeof fetch),
    )
    await OutboundTelemetry.initializeAccount()
    await OutboundTelemetry.status(true)
    await OutboundTelemetry.userMessage({
      sessionID: "ses_opt_out_upload",
      messageID: "msg_uploading",
      message: { role: "user" },
      parts: [{ text: "one final pre-opt-out trace" }],
    })
    await batchStarted.promise

    let optOutSettled = false
    const optingOut = OutboundTelemetry.setAnalytics(false).finally(() => {
      optOutSettled = true
    })
    await Bun.sleep(30)
    expect(optOutSettled).toBe(false)

    finishBatch.resolve()
    expect(await optingOut).toMatchObject({ analyticsEnabled: false, researchContentEnabled: false })
    await OutboundTelemetry.flush()
    expect(batchUploads).toBe(1)
    expect(await Bun.file(queue).exists()).toBe(false)
  })

  test("an append paused before the lease cannot resurrect the queue after opt-out", async () => {
    await signIn("user_opt_out_race")
    restores.push(spyOn(globalThis, "fetch").mockRejectedValue(new Error("offline")))
    await OutboundTelemetry.initializeAccount()

    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const original = OpenScience.scrubSecrets
    restores.push(
      spyOn(OpenScience, "scrubSecrets").mockImplementation((async (value: unknown) => {
        entered.resolve()
        await release.promise
        return original(value)
      }) as typeof OpenScience.scrubSecrets),
    )
    const appending = OutboundTelemetry.userMessage({
      sessionID: "ses_opt_out_race",
      messageID: "msg_stale_append",
      message: { role: "user" },
      parts: [{ text: "must never be queued" }],
    })
    await entered.promise

    expect(await OutboundTelemetry.setAnalytics(false)).toMatchObject({ analyticsEnabled: false })
    release.resolve()
    expect(await appending).toBe(false)
    expect(await Bun.file(queue).exists()).toBe(false)
    // A stale append remains blocked after the setting has durably changed.
    expect(await OutboundTelemetry.status(true)).toMatchObject({
      analyticsEnabled: false,
      researchContentEnabled: false,
    })
  })

  test("migrates the previous explicit opt-out and discards the content-free queue", async () => {
    await signIn("user_migrated")
    await Bun.write(
      legacyConsent,
      JSON.stringify({
        schema_version: 1,
        consent_version: "openscience-analytics-2026-08-20",
        installation_id: crypto.randomUUID(),
        active_subject: "account:user_migrated",
        subjects: {
          "account:user_migrated": {
            analytics_enabled: false,
            research_content_enabled: false,
            updated_at: new Date().toISOString(),
          },
        },
      }),
    )
    await Bun.write(legacyQueue, '{"legacy":true}\n')
    restores.push(spyOn(globalThis, "fetch").mockRejectedValue(new Error("offline")))
    await OutboundTelemetry.initializeAccount()
    expect(await OutboundTelemetry.status()).toMatchObject({
      analyticsEnabled: false,
      researchContentEnabled: false,
    })
    expect(await Bun.file(legacyQueue).exists()).toBe(false)
  })

  test("deletion uses the trace scope and leaves data use off", async () => {
    await signIn("user_delete")
    const calls: RequestInit[] = []
    restores.push(
      spyOn(globalThis, "fetch").mockImplementation((async (input, init) => {
        if (String(input).endsWith("/api/v1/telemetry/account-data")) {
          calls.push(init ?? {})
          return Response.json({ status: "completed", scope: "traces" })
        }
        return Response.json({
          consent_version: CONSENT_VERSION,
          analytics_enabled: true,
          research_content_enabled: true,
        })
      }) as typeof fetch),
    )
    await OutboundTelemetry.initializeAccount()
    expect(await OutboundTelemetry.requestDeletion()).toEqual({ ok: true })
    expect(JSON.parse(String(calls[0]?.body))).toEqual({ scope: "traces" })
    // The server mock deliberately reports its default-on value. The durable
    // local deletion tombstone must still win on an explicit refresh.
    expect(await OutboundTelemetry.status(true)).toMatchObject({
      analyticsEnabled: false,
      researchContentEnabled: false,
    })
  })

  test("deletion holds the state lease so concurrent capture cannot upload or recreate the queue", async () => {
    await signIn("user_delete_race")
    const offline = spyOn(globalThis, "fetch").mockRejectedValue(new Error("offline"))
    restores.push(offline)
    await OutboundTelemetry.initializeAccount()
    await OutboundTelemetry.userMessage({
      sessionID: "ses_delete_race",
      messageID: "msg_before_delete",
      message: { role: "user" },
      parts: [{ text: "queued before deletion" }],
    })
    await Bun.sleep(20)
    offline.mockRestore()
    restores.pop()

    const deleting = Promise.withResolvers<void>()
    const finishDeletion = Promise.withResolvers<void>()
    let batchUploads = 0
    restores.push(
      spyOn(globalThis, "fetch").mockImplementation((async (input) => {
        const url = String(input)
        if (url.endsWith("/api/v1/telemetry/account-data")) {
          deleting.resolve()
          await finishDeletion.promise
          return Response.json({ status: "completed", scope: "traces" })
        }
        if (url.endsWith("/api/v1/telemetry/batches")) batchUploads++
        throw new Error(`Unexpected request: ${url}`)
      }) as typeof fetch),
    )

    const removal = OutboundTelemetry.requestDeletion()
    await deleting.promise
    const uploadsBeforeDeletion = batchUploads
    let appendSettled = false
    const appending = OutboundTelemetry.userMessage({
      sessionID: "ses_delete_race",
      messageID: "msg_during_delete",
      message: { role: "user" },
      parts: [{ text: "must remain local" }],
    }).finally(() => {
      appendSettled = true
    })
    await Bun.sleep(30)
    expect(appendSettled).toBe(false)

    finishDeletion.resolve()
    expect(await removal).toEqual({ ok: true })
    expect(await appending).toBe(false)
    // A retry selected before deletion may finish first; the authenticated
    // deletion removes it. Nothing may upload after deletion acquires the
    // account and state boundaries.
    expect(batchUploads).toBe(uploadsBeforeDeletion)
    expect(await Bun.file(queue).exists()).toBe(false)
  })

  test("independent processes preserve every concurrent enqueue under the shared file lease", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openscience-telemetry-race-"))
    const runner = path.join(root, "enqueue.ts")
    const telemetry = new URL("../../src/telemetry/outbound.ts", import.meta.url).href
    const total = 6
    await fs.mkdir(root, { recursive: true })
    await Bun.write(
      path.join(root, "openscience-session.json"),
      JSON.stringify({ api_key: "thk_fixture", user_id: "user_process_race" }),
    )
    await Bun.write(
      runner,
      `
import { OutboundTelemetry } from ${JSON.stringify(telemetry)}
const index = process.argv[2]
const recorded = await OutboundTelemetry.userMessage({
  sessionID: "ses_process_race",
  messageID: "msg_" + index,
  message: { role: "user" },
  parts: [{ text: "concurrent-" + index }],
})
if (!recorded) throw new Error("trace was not recorded: " + JSON.stringify(await OutboundTelemetry.status()))
`,
    )

    try {
      const children = Array.from({ length: total }, (_, index) =>
        Bun.spawn([process.execPath, runner, String(index)], {
          cwd: path.resolve(import.meta.dir, "../.."),
          env: {
            ...process.env,
            OPENSCIENCE_DATA_DIR: root,
            OPENSCIENCE_CONFIG_DIR: path.join(root, "config"),
            OPENSCIENCE_TEST_HOME: path.join(root, "home"),
            XDG_CACHE_HOME: path.join(root, "cache"),
            XDG_CONFIG_HOME: path.join(root, "config-xdg"),
            XDG_DATA_HOME: path.join(root, "data-xdg"),
            XDG_STATE_HOME: path.join(root, "state-xdg"),
          },
          stdout: "pipe",
          stderr: "pipe",
        }),
      )
      const results = await Promise.all(
        children.map(async (child) => ({
          exit: await child.exited,
          stderr: await new Response(child.stderr).text(),
        })),
      )
      expect(results.filter((result) => result.exit !== 0)).toEqual([])
      const rows = (await Bun.file(path.join(root, "telemetry-queue-v2.jsonl")).text())
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as { event: { run_id?: string } })
      expect(rows).toHaveLength(total)
      expect(new Set(rows.map((row) => row.event.run_id))).toEqual(
        new Set(Array.from({ length: total }, (_, index) => `msg_${index}`)),
      )
      expect(await Bun.file(path.join(root, "telemetry-state-v2.lock")).exists()).toBe(false)
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  }, 20_000)
})
