import { afterEach, describe, expect, spyOn, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { gunzipSync } from "node:zlib"
import { Global } from "../../src/global"
import { coarsePlatform, CONSENT_VERSION, Event, OutboundTelemetry, telemetryKeyID } from "../../src/telemetry/outbound"

const consent = path.join(Global.Path.data, "telemetry-consent-v1.json")
const queue = path.join(Global.Path.data, "telemetry-queue-v1.jsonl")
const session = path.join(Global.Path.data, "openscience-session.json")

afterEach(async () => {
  await Promise.all([consent, queue, session].map((file) => fs.rm(file, { force: true })))
})

describe("outbound telemetry contract", () => {
  test("parses the byte-matched Gateway telemetry batch fixture", async () => {
    const fixture = (await Bun.file(new URL("../fixture/telemetry_batch_v1.json", import.meta.url)).json()) as {
      schema_version: number
      consent_version: string
      events: unknown[]
    }
    expect(fixture.schema_version).toBe(1)
    expect(fixture.consent_version).toBe(CONSENT_VERSION)
    expect(fixture.events.map((event) => Event.parse(event))).toHaveLength(1)
    expect(fixture.events[0]).toMatchObject({ event_type: "assistant.completed", model_family: "gpt-5" })
  })

  test("accepts only the content-free event allowlist", () => {
    const base = {
      event_id: crypto.randomUUID(),
      schema_version: 1 as const,
      event_type: "assistant.completed",
      occurred_at: new Date().toISOString(),
    }
    expect(Event.parse({ ...base, input_tokens: null, success: true })).toMatchObject(base)
    expect(Event.safeParse({ ...base, event_type: "prompt_recorded" }).success).toBe(false)
    expect(Event.safeParse({ ...base, tool_name: "alice_private_lab_plugin" }).success).toBe(false)
    expect(Event.safeParse({ ...base, error_class: "SecretProjectFailure" }).success).toBe(false)
    for (const prohibited of ["prompt", "response", "query", "url", "file_path", "metadata"]) {
      expect(Event.safeParse({ ...base, [prohibited]: "content" }).success).toBe(false)
    }
  })

  test("defaults on when absent and persists a corrupt record as fail-closed", async () => {
    expect(await OutboundTelemetry.status()).toMatchObject({
      analyticsEnabled: true,
      researchContentEnabled: false,
      source: "default",
    })
    await Bun.write(consent, "{not-json")
    expect(await OutboundTelemetry.status()).toMatchObject({ analyticsEnabled: false, corrupt: true })
    expect(await OutboundTelemetry.status()).toMatchObject({ analyticsEnabled: false, corrupt: false })
  })

  test("consumes the Gateway top-level consent shape and deletion scope", async () => {
    await Bun.write(session, JSON.stringify({ api_key: "thk_fixture", user_id: "user_fixture" }))
    const calls: Array<{ url: string; init?: RequestInit }> = []
    const fetcher = spyOn(globalThis, "fetch").mockImplementation((async (input, init) => {
      const url = String(input)
      calls.push({ url, init })
      if (url.endsWith("/api/v1/telemetry/consent")) {
        return Response.json({
          schema_version: 1,
          consent_version: CONSENT_VERSION,
          analytics_enabled: false,
          research_content_enabled: false,
          source: "account",
        })
      }
      if (url.endsWith("/api/v1/telemetry/account-data")) {
        return Response.json({ request_id: "delete_fixture", status: "completed", scope: "analytics" })
      }
      throw new Error(`Unexpected request: ${url}`)
    }) as typeof fetch)
    try {
      expect(await OutboundTelemetry.status(true)).toMatchObject({ analyticsEnabled: false, source: "account" })
      const before = (await Bun.file(consent).json()) as { installation_id: string }
      expect(await OutboundTelemetry.requestDeletion()).toEqual({ ok: true })
      const deletion = calls.find((call) => call.url.endsWith("/api/v1/telemetry/account-data"))
      expect(deletion?.init?.method).toBe("DELETE")
      expect(JSON.parse(String(deletion?.init?.body))).toEqual({ scope: "analytics" })
      expect(calls.every((call) => new Headers(call.init?.headers).get("authorization") === "Bearer thk_fixture")).toBe(
        true,
      )
      const after = (await Bun.file(consent).json()) as { installation_id: string }
      expect(after.installation_id).not.toBe(before.installation_id)
      expect(await OutboundTelemetry.status()).toMatchObject({ analyticsEnabled: false, pending: false })
      expect(await Bun.file(queue).exists()).toBe(false)
    } finally {
      fetcher.mockRestore()
    }
  })

  test("checks signed-in account consent before the first event can be queued", async () => {
    await Bun.write(session, JSON.stringify({ api_key: "thk_opted_out", user_id: "user_opted_out" }))
    let consentReads = 0
    let batches = 0
    const fetcher = spyOn(globalThis, "fetch").mockImplementation((async (input) => {
      const url = String(input)
      if (url.endsWith("/api/v1/telemetry/consent")) {
        consentReads++
        return Response.json({
          schema_version: 1,
          consent_version: CONSENT_VERSION,
          analytics_enabled: false,
          research_content_enabled: false,
          source: "account",
        })
      }
      if (url.endsWith("/api/v1/telemetry/batches")) {
        batches++
        return Response.json({ accepted: [], replayed: [], rejected: [] })
      }
      throw new Error(`Unexpected request: ${url}`)
    }) as typeof fetch)
    try {
      expect(
        await OutboundTelemetry.assistant({
          sessionID: "session_must_not_queue",
          route: "managed",
          provider: "openai",
          model: "gpt-5",
          tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
        }),
      ).toBe(false)
      await OutboundTelemetry.flush()
      expect(consentReads).toBe(1)
      expect(batches).toBe(0)
      expect(await Bun.file(queue).exists()).toBe(false)
      expect(await OutboundTelemetry.status()).toMatchObject({ analyticsEnabled: false, pending: false })
    } finally {
      fetcher.mockRestore()
    }
  })

  test("fails closed when signed-in consent cannot be confirmed", async () => {
    await Bun.write(session, JSON.stringify({ api_key: "thk_offline", user_id: "user_offline" }))
    const fetcher = spyOn(globalThis, "fetch").mockRejectedValue(new Error("Gateway offline"))
    try {
      expect(
        await OutboundTelemetry.assistant({
          sessionID: "session_offline",
          route: "managed",
          provider: "openai",
          model: "gpt-5",
          tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
        }),
      ).toBe(false)
      expect(await Bun.file(queue).exists()).toBe(false)
      expect(await OutboundTelemetry.status()).toMatchObject({ analyticsEnabled: false, pending: true })
    } finally {
      fetcher.mockRestore()
    }
  })

  test("does not delay model setup while signed-in consent is still loading", async () => {
    await Bun.write(session, JSON.stringify({ api_key: "thk_stalled", user_id: "user_stalled" }))
    let release!: (value: Response) => void
    const stalled = new Promise<Response>((resolve) => {
      release = resolve
    })
    const fetcher = spyOn(globalThis, "fetch").mockImplementation((async (input) => {
      expect(String(input).endsWith("/api/v1/telemetry/consent")).toBe(true)
      return stalled
    }) as typeof fetch)
    try {
      const result = await Promise.race([OutboundTelemetry.enabled(), Bun.sleep(100).then(() => "timed-out" as const)])
      expect(result).toBe(false)
      release(
        Response.json({
          schema_version: 1,
          consent_version: CONSENT_VERSION,
          analytics_enabled: true,
          research_content_enabled: false,
          source: "account",
        }),
      )
      await Bun.sleep(10)
      expect(await OutboundTelemetry.enabled()).toBe(true)
    } finally {
      release(Response.json({ analytics_enabled: false }))
      fetcher.mockRestore()
    }
  })

  test("normalizes macOS and Windows platform names to the Gateway contract", async () => {
    expect(coarsePlatform("darwin")).toBe("macos")
    expect(coarsePlatform("win32")).toBe("windows")
    expect(coarsePlatform("linux")).toBe("linux")
    expect(coarsePlatform("freebsd")).toBe("unknown")
    expect(
      Event.parse({
        event_id: crypto.randomUUID(),
        schema_version: 1,
        event_type: "assistant.completed",
        occurred_at: new Date().toISOString(),
        platform: "macos",
      }).platform,
    ).toBe("macos")
    expect(
      Event.safeParse({
        event_id: crypto.randomUUID(),
        schema_version: 1,
        event_type: "assistant.completed",
        occurred_at: new Date().toISOString(),
        platform: "darwin",
      }).success,
    ).toBe(false)
  })

  test("uses only the public Gateway key id and fails closed for malformed legacy credentials", async () => {
    const keyID = `thk_${"a".repeat(32)}`
    const secret = "never_persist_this_secret_value"
    const token = `${keyID}.${secret}`
    expect(telemetryKeyID(token)).toBe(keyID)
    expect(telemetryKeyID("thk_legacy-secret-without-an-id")).toBeUndefined()

    await Bun.write(session, JSON.stringify({ api_key: token }))
    const fetcher = spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({
        schema_version: 1,
        consent_version: CONSENT_VERSION,
        analytics_enabled: true,
        research_content_enabled: false,
        source: "account",
      }),
    )
    try {
      expect(await OutboundTelemetry.status(true)).toMatchObject({ analyticsEnabled: true, source: "account" })
      const persisted = await Bun.file(consent).text()
      expect(persisted).toContain(keyID)
      expect(persisted).not.toContain(secret)

      fetcher.mockClear()
      await Bun.write(session, JSON.stringify({ api_key: "thk_legacy-secret-without-an-id" }))
      expect(await OutboundTelemetry.status(true)).toMatchObject({ analyticsEnabled: false, pending: true })
      expect(fetcher).not.toHaveBeenCalled()
    } finally {
      fetcher.mockRestore()
    }
  })

  test("purges and disables a subject when Gateway rejects a batch for disabled consent", async () => {
    await Bun.write(session, JSON.stringify({ api_key: "thk_revoked", user_id: "user_revoked" }))
    let batches = 0
    const fetcher = spyOn(globalThis, "fetch").mockImplementation((async (input) => {
      const url = String(input)
      if (url.endsWith("/api/v1/telemetry/consent")) {
        return Response.json({
          schema_version: 1,
          consent_version: CONSENT_VERSION,
          analytics_enabled: true,
          research_content_enabled: false,
          source: "account",
        })
      }
      if (url.endsWith("/api/v1/telemetry/batches")) {
        batches++
        return Response.json({ detail: { code: "telemetry_consent_disabled", retryable: false } }, { status: 403 })
      }
      throw new Error(`Unexpected request: ${url}`)
    }) as typeof fetch)
    const automaticFlush = spyOn(OutboundTelemetry, "flush").mockResolvedValue()
    try {
      expect(
        await OutboundTelemetry.assistant({
          sessionID: "session_queued_before_revocation",
          route: "managed",
          provider: "openai",
          model: "gpt-5",
          tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
        }),
      ).toBe(true)
      expect(await Bun.file(queue).exists()).toBe(true)
      automaticFlush.mockRestore()

      await OutboundTelemetry.flush()
      expect(batches).toBe(1)
      expect(await Bun.file(queue).exists()).toBe(false)
      expect(await OutboundTelemetry.status()).toMatchObject({ analyticsEnabled: false, pending: false })
      expect(
        await OutboundTelemetry.assistant({
          sessionID: "session_must_never_backfill",
          route: "managed",
          provider: "openai",
          model: "gpt-5",
          tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
        }),
      ).toBe(false)
      expect(batches).toBe(1)
    } finally {
      automaticFlush.mockRestore()
      fetcher.mockRestore()
    }
  })

  test("sends a signed-out pseudonymous gzip batch without account fields", async () => {
    const payloads: Array<Record<string, unknown>> = []
    const fetcher = spyOn(globalThis, "fetch").mockImplementation((async (_input, init) => {
      const headers = new Headers(init?.headers)
      expect(headers.get("authorization")).toBeNull()
      expect(headers.get("content-encoding")).toBe("gzip")
      const body = init?.body as Uint8Array
      payloads.push(JSON.parse(gunzipSync(body).toString("utf8")))
      return Response.json({
        accepted: ["event_fixture"],
        replayed: [],
        rejected: [],
        schema_version: 1,
        consent_version: CONSENT_VERSION,
        retention_days: 30,
      })
    }) as typeof fetch)
    try {
      await OutboundTelemetry.assistant({
        sessionID: "session-content-must-not-escape",
        route: "local",
        provider: "ollama",
        model: "local-family",
        tokens: { input: 1, output: 2, reasoning: 0, cache: { read: 0, write: 0 } },
      })
      await OutboundTelemetry.flush()
      expect(payloads.length).toBeGreaterThan(0)
      const envelope = payloads[0] as { consent_version?: string; events?: Array<Record<string, unknown>> }
      expect(envelope.consent_version).toBe(CONSENT_VERSION)
      expect(envelope.events?.[0]).toMatchObject({ event_type: "assistant.completed", model_route: "local" })
      expect(envelope.events?.[0]).not.toHaveProperty("account_id")
      expect(JSON.stringify(envelope)).not.toContain("session-content-must-not-escape")
    } finally {
      fetcher.mockRestore()
    }
  })

  test("coarsens hostile custom provider and model ids before they enter an outbound event", async () => {
    const payloads: Array<Record<string, unknown>> = []
    const fetcher = spyOn(globalThis, "fetch").mockImplementation((async (_input, init) => {
      payloads.push(JSON.parse(gunzipSync(init?.body as Uint8Array).toString("utf8")))
      return Response.json({
        accepted: [],
        replayed: [],
        rejected: [],
        schema_version: 1,
        consent_version: CONSENT_VERSION,
        retention_days: 30,
      })
    }) as typeof fetch)
    const provider = "../../Users/alice/lab-provider"
    const model = "/private/research/secret-model-name"
    try {
      await OutboundTelemetry.assistant({
        sessionID: "session-hostile-model",
        route: "byok",
        provider,
        model,
        tokens: { input: 1, output: 2, reasoning: 0, cache: { read: 0, write: 0 } },
      })
      await OutboundTelemetry.flush()
      const serialized = JSON.stringify(payloads)
      expect(serialized).not.toContain(provider)
      expect(serialized).not.toContain(model)
      const events = payloads.flatMap((payload) => (payload.events ?? []) as Array<Record<string, unknown>>)
      expect(events).toContainEqual(
        expect.objectContaining({ provider_family: "custom", model_family: "custom", model_route: "byok" }),
      )
    } finally {
      fetcher.mockRestore()
    }
  })

  test("coarsens a hostile plugin tool id before it enters the queue or batch", async () => {
    const payloads: Array<Record<string, unknown>> = []
    const fetcher = spyOn(globalThis, "fetch").mockImplementation((async (_input, init) => {
      payloads.push(JSON.parse(gunzipSync(init?.body as Uint8Array).toString("utf8")))
      return Response.json({
        accepted: [],
        replayed: [],
        rejected: [],
        schema_version: 1,
        consent_version: CONSENT_VERSION,
        retention_days: 30,
      })
    }) as typeof fetch)
    const tool = "../../Users/alice/private tool/plugin"
    try {
      await OutboundTelemetry.tool({
        id: "part_fixture",
        messageID: "message_fixture",
        sessionID: "session_fixture",
        type: "tool",
        callID: "call_fixture",
        tool,
        state: {
          status: "completed",
          input: {},
          output: "content must stay local",
          title: "private title",
          metadata: {},
          time: { start: 1, end: 2 },
        },
      } as never)
      await OutboundTelemetry.flush()
      const serialized = JSON.stringify(payloads)
      expect(serialized).not.toContain(tool)
      expect(serialized).not.toContain("private title")
      expect(serialized).not.toContain("content must stay local")
      const events = payloads.flatMap((payload) => (payload.events ?? []) as Array<Record<string, unknown>>)
      expect(events).toContainEqual(expect.objectContaining({ event_type: "tool.completed", tool_name: "custom" }))
    } finally {
      fetcher.mockRestore()
    }
  })

  test("uses closed tool and error classes even for safe-looking custom values", async () => {
    const payloads: Array<Record<string, unknown>> = []
    const fetcher = spyOn(globalThis, "fetch").mockImplementation((async (_input, init) => {
      payloads.push(JSON.parse(gunzipSync(init?.body as Uint8Array).toString("utf8")))
      return Response.json({ accepted: [], replayed: [], rejected: [] })
    }) as typeof fetch)
    const tool = "alice_private_lab_plugin"
    const error = "SecretProjectFailure: /Users/alice/private-study"
    try {
      await OutboundTelemetry.tool({
        id: "part_error_fixture",
        messageID: "message_error_fixture",
        sessionID: "session_error_fixture",
        type: "tool",
        callID: "call_error_fixture",
        tool,
        state: {
          status: "error",
          input: {},
          error,
          time: { start: 1, end: 2 },
        },
      } as never)
      await OutboundTelemetry.flush()
      const serialized = JSON.stringify(payloads)
      expect(serialized).not.toContain(tool)
      expect(serialized).not.toContain("SecretProjectFailure")
      expect(serialized).not.toContain("private-study")
      const events = payloads.flatMap((payload) => (payload.events ?? []) as Array<Record<string, unknown>>)
      expect(events).toContainEqual(
        expect.objectContaining({ event_type: "tool.completed", tool_name: "custom", error_class: "unknown" }),
      )
    } finally {
      fetcher.mockRestore()
    }
  })
})
