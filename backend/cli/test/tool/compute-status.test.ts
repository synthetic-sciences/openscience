import { test, expect, describe, beforeEach, afterEach } from "bun:test"
import path from "path"
import fs from "fs/promises"
import { ComputeStatusTool } from "../../src/tool/compute"
import { ComputeMode } from "../../src/compute/mode"
import { ToolRegistry } from "../../src/tool/registry"
import { Instance } from "../../src/project/instance"
import { Global } from "../../src/global"
import { tmpdir } from "../fixture/fixture"

// Every credential variable across ComputeMode.PROVIDERS, derived rather than
// hand-typed so it can never drift out of sync with the sibling scrub list in
// test/tool/skill-compute-filter.test.ts (a hand-typed subset previously let
// an ambient PRIME_API_KEY, TENSORPOOL_KEY, VAST_API_KEY, or
// LAMBDA_LABS_API_KEY leak into these tests and produce false failures).
const ENV = Object.values(ComputeMode.PROVIDERS).flatMap((provider) => provider.env.flat())
const SESSION = path.join(Global.Path.data, "openscience-session.json")
const realFetch = globalThis.fetch

const CTX = {
  sessionID: "ses_test",
  messageID: "msg_test",
  agent: "research",
  abort: new AbortController().signal,
  messages: [],
  metadata: () => {},
  ask: async () => {},
}

/** Every URL fetched since the last reset, so "only one network call" is a
 *  positive assertion rather than an absence of failure (mirrors
 *  test/compute/mode.test.ts's `calls`). */
let calls: string[] = []

function stub(body: unknown, status = 200) {
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input instanceof Request ? input.url : input)
    calls.push(url)
    if (!url.includes("/api/compute/options")) return realFetch(input as never)
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
  }) as typeof fetch
}

const MANAGED_ON = {
  providers: [{ provider: "lambda", funding: "managed", has_byok: false, has_operator: true, count: 2 }],
  resell_enabled: true,
  cli_effective_balance_cents: 4200,
}
const MANAGED_OFF = { providers: [], resell_enabled: false, cli_effective_balance_cents: 0 }
const MANAGED_ZERO = {
  providers: [{ provider: "lambda", funding: "managed", has_byok: false, has_operator: true, count: 2 }],
  resell_enabled: true,
  cli_effective_balance_cents: 0,
}

async function run(skills: string[], fn?: () => Promise<void>) {
  await using tmp = await tmpdir({
    git: true,
    init: async (dir) => {
      for (const name of skills) {
        await Bun.write(
          path.join(dir, ".openscience", "skill", name, "SKILL.md"),
          `---\nname: ${name}\ndescription: Fixture ${name}.\ncategory: cloud-compute\n---\n\n# ${name}\n`,
        )
      }
    },
  })
  return Instance.provide({
    directory: tmp.path,
    fn: async () => {
      await fn?.()
      const tool = await ComputeStatusTool.init({})
      return tool.execute({}, CTX as never)
    },
  })
}

describe("compute_status", () => {
  beforeEach(async () => {
    for (const name of ENV) delete process.env[name]
    calls = []
    ComputeMode.invalidate()
    await fs.mkdir(Global.Path.data, { recursive: true })
    await Bun.write(SESSION, JSON.stringify({ api_key: "thk_t.s", user_id: "u1" }))
  })
  afterEach(async () => {
    globalThis.fetch = realFetch
    for (const name of ENV) delete process.env[name]
    await fs.rm(SESSION, { force: true }).catch(() => {})
  })

  test("byok reports the mode, the usable providers, and byok guidance", async () => {
    stub(MANAGED_ON)
    process.env["LAMBDA_API_KEY"] = "k"
    const result = await run(["lambda-labs-gpu-cloud"])
    expect(result.metadata.mode).toBe("byok")
    expect(result.metadata.providers).toEqual(["lambda"])
    expect(result.output).toContain("lambda")
    expect(result.output.toLowerCase()).toContain("do not launch managed")
    expect(result.metadata.balance_usd).toBeUndefined()
  })

  test("managed reports the balance and managed guidance, from a single network call", async () => {
    stub(MANAGED_ON)
    const result = await run([])
    expect(result.metadata.mode).toBe("managed")
    expect(result.metadata.balance_usd).toBe(42)
    expect(result.output).toContain("42")
    expect(result.output.toLowerCase()).toContain("credits")
    // balance_usd must come from the SAME /api/compute/options response that
    // decided managed availability, never a second round trip.
    expect(calls.filter((url) => url.includes("/api/compute/options")).length).toBe(1)
  })

  test("managed with a zero balance stops telling the agent to spend it", async () => {
    // Live testing against a deployed Atlas backend with a zero wallet found
    // /api/compute/options reports a "managed" provider regardless of
    // balance — availability and affordability are independent. Every lease
    // attempt in this state returns HTTP 402 insufficient_cli_credit, so the
    // old guidance sent the agent down a path that cannot work while also
    // forbidding the only fallback (the user's own keys).
    stub(MANAGED_ZERO)
    const result = await run([])
    expect(result.output.toLowerCase()).not.toContain("run gpu work through managed compute")
    expect(result.output.toLowerCase()).toContain("top up")
  })

  test("managed with a positive balance keeps today's guidance", async () => {
    stub(MANAGED_ON)
    const result = await run([])
    expect(result.output.toLowerCase()).toContain("run gpu work through managed compute")
  })

  test("a zero balance narrows guidance only — mode stays managed, balance stays reported", async () => {
    stub(MANAGED_ZERO)
    const result = await run([])
    expect(result.metadata.mode).toBe("managed")
    expect(result.metadata.balance_usd).toBe(0)
  })

  test("none tells the agent not to attempt GPU work and how to enable it", async () => {
    stub(MANAGED_OFF)
    const result = await run([])
    expect(result.metadata.mode).toBe("none")
    expect(result.output.toLowerCase()).toContain("do not attempt gpu work")
    expect(result.output).toContain("Settings")
    expect(result.metadata.balance_usd).toBeUndefined()
  })

  test("a provider with a key but no skill is still reported as usable byok", async () => {
    stub(MANAGED_OFF)
    process.env["RUNPOD_API_KEY"] = "rpa_x"
    const result = await run([])
    expect(result.metadata.mode).toBe("byok")
    expect(result.metadata.providers).toEqual(["runpod"])
    expect(result.output).toContain("runpod")
  })

  test("the three modes produce three DIFFERENT guidance strings", async () => {
    stub(MANAGED_ON)
    process.env["LAMBDA_API_KEY"] = "k"
    const byok = await run(["lambda-labs-gpu-cloud"])
    delete process.env["LAMBDA_API_KEY"]
    ComputeMode.invalidate()
    const managed = await run([])
    stub(MANAGED_OFF)
    ComputeMode.invalidate()
    const none = await run([])
    // Comparing whole `output` strings is a false positive: the leading
    // `**mode**: byok|managed|none` line always differs by itself, so a
    // whole-string comparison would pass even if GUIDANCE collapsed to one
    // shared string. A formatting-position trick (e.g. "text after the last
    // blank line") is equally fragile — it breaks the moment the separator
    // between the report and the guidance changes shape, which is a pure
    // formatting edit that should never fail this test.
    //
    // Assert against the actual contract instead: each mode's GUIDANCE entry
    // carries a short, semantically load-bearing phrase that could not
    // survive a collapse to one shared string, and that phrase must appear
    // in that mode's output and ONLY that mode's output.
    const PHRASE = {
      byok: "do not launch managed",
      managed: "do not use the user's own provider keys",
      none: "do not attempt gpu work",
    }
    const output = {
      byok: byok.output.toLowerCase(),
      managed: managed.output.toLowerCase(),
      none: none.output.toLowerCase(),
    }
    for (const mode of Object.keys(PHRASE) as (keyof typeof PHRASE)[]) {
      expect(output[mode]).toContain(PHRASE[mode])
      for (const other of Object.keys(PHRASE) as (keyof typeof PHRASE)[]) {
        if (other === mode) continue
        expect(output[mode]).not.toContain(PHRASE[other])
      }
    }
  })

  test("a credential connected between two calls changes the answer, no restart", async () => {
    stub(MANAGED_OFF)
    const before = await run([])
    expect(before.metadata.mode).toBe("none")
    process.env["LAMBDA_API_KEY"] = "connected-mid-session"
    const after = await run(["lambda-labs-gpu-cloud"])
    expect(after.metadata.mode).toBe("byok")
  })

  test("the description instructs the agent to check before running GPU work", async () => {
    const tool = await ComputeStatusTool.init({})
    expect(tool.description.toLowerCase()).toContain("before")
    expect(tool.description.toLowerCase()).toContain("gpu")
    expect(tool.description).toContain("byok")
    expect(tool.description).toContain("managed")
    expect(tool.description).toContain("none")
  })

  test("the tool is registered", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        expect(await ToolRegistry.ids()).toContain("compute_status")
      },
    })
  })
})
