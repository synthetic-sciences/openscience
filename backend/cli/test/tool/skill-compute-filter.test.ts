import { test, expect, describe, beforeEach, afterEach } from "bun:test"
import path from "path"
import fs from "fs/promises"
import { SkillTool } from "../../src/tool/skill"
import { ComputeStatusTool } from "../../src/tool/compute"
import { ComputeMode } from "../../src/compute/mode"
import { Instance } from "../../src/project/instance"
import { Global } from "../../src/global"
import { tmpdir } from "../fixture/fixture"

// All ten credential variables across ComputeMode.PROVIDERS (modal x2, lambda x2,
// tensorpool x2, prime x2, runpod x1, vast x1) — matches test/compute/mode.test.ts's
// ENV list. A partial list lets a developer's own ambient shell keys (e.g. a real
// PRIME_API_KEY) leak into tests asserting an empty catalog.
const ENV = [
  "MODAL_TOKEN_ID",
  "MODAL_TOKEN_SECRET",
  "LAMBDA_API_KEY",
  "LAMBDA_LABS_API_KEY",
  "TENSORPOOL_KEY",
  "TENSORPOOL_API_KEY",
  "PRIME_API_KEY",
  "PRIME_INTELLECT_API_KEY",
  "RUNPOD_API_KEY",
  "VAST_API_KEY",
]
const SESSION = path.join(Global.Path.data, "openscience-session.json")
const realFetch = globalThis.fetch

const CTX = {
  sessionID: "s",
  messageID: "m",
  agent: "research",
  abort: new AbortController().signal,
  messages: [],
  metadata: () => {},
  ask: async () => {},
}

// Every provider skill, plus two skills that must never be filtered: a
// non-compute one and a cloud-compute skill that maps to no panel provider.
const ALL = [
  ["modal-serverless-gpu", "cloud-compute"],
  ["lambda-labs-gpu-cloud", "cloud-compute"],
  ["tensorpool-gpu-cloud", "cloud-compute"],
  ["prime-intellect-lab", "ml-training"],
  ["tinker-fine-tuning", "cloud-compute"],
  ["rdkit", "chemistry"],
] as const

function stub(managed: boolean) {
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input instanceof Request ? input.url : input)
    if (!url.includes("/api/compute/options")) return realFetch(input as never)
    return new Response(
      JSON.stringify({
        providers: managed ? [{ provider: "lambda", funding: "managed" }] : [],
        resell_enabled: managed,
        cli_effective_balance_cents: 500,
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    )
  }) as typeof fetch
}

async function project(fn: (dir: string) => Promise<unknown>) {
  return tmpdir({
    git: true,
    init: async (dir) => {
      for (const [name, category] of ALL) {
        await Bun.write(
          path.join(dir, ".openscience", "skill", name, "SKILL.md"),
          `---\nname: ${name}\ndescription: Fixture ${name}.\ncategory: ${category}\n---\n\n# ${name}\n`,
        )
      }
      await fn(dir)
    },
  })
}

/** Which of the six provider skills does the tool offer? Read from the tool's
 *  own category listing, which is what the model sees. */
async function offered(): Promise<string[]> {
  const tool = await SkillTool.init({})
  const found: string[] = []
  for (const category of ["cloud-compute", "ml-training"]) {
    const result = await tool.execute({ category }, CTX as never).catch(() => undefined)
    if (result) found.push(result.output)
  }
  const text = found.join("\n")
  return [...ComputeMode.SKILLS].filter((name) => text.includes(`**${name}**`)).sort()
}

async function nonComputeVisible(): Promise<boolean> {
  const tool = await SkillTool.init({})
  const result = await tool.execute({ category: "chemistry" }, CTX as never)
  return result.output.includes("**rdkit**")
}

async function tinkerVisible(): Promise<boolean> {
  const tool = await SkillTool.init({})
  const result = await tool.execute({ category: "cloud-compute" }, CTX as never)
  return result.output.includes("**tinker-fine-tuning**")
}

/** The compute_status tool's own verdict — the second surface that must agree
 *  with SkillTool's catalog filter about which providers are usable. */
async function computeStatus(): Promise<{ mode: string; providers: string[] }> {
  const tool = await ComputeStatusTool.init({})
  const result = await tool.execute({}, CTX as never)
  return result.metadata as { mode: string; providers: string[] }
}

describe("skill catalog filtering by compute mode", () => {
  beforeEach(async () => {
    for (const name of ENV) delete process.env[name]
    ComputeMode.invalidate()
    await fs.mkdir(Global.Path.data, { recursive: true })
    await Bun.write(SESSION, JSON.stringify({ api_key: "thk_t.s", user_id: "u1" }))
  })
  afterEach(async () => {
    globalThis.fetch = realFetch
    for (const name of ENV) delete process.env[name]
    await fs.rm(SESSION, { force: true }).catch(() => {})
  })

  test("with only a Modal credential, only Modal's skills are offered", async () => {
    stub(false)
    process.env["MODAL_TOKEN_ID"] = "ak-a"
    process.env["MODAL_TOKEN_SECRET"] = "as-b"
    await using tmp = await project(async () => {})
    const names = await Instance.provide({ directory: tmp.path, fn: offered })
    expect(names).toEqual(["modal-serverless-gpu"])
  })

  test("a RunPod credential is byok but contributes no skills — nobody else's are offered either", async () => {
    stub(false)
    process.env["RUNPOD_API_KEY"] = "rpa_x"
    await using tmp = await project(async () => {})
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        // RunPod carries skills: [] (Decision 2), so being credentialed makes the
        // user byok without unlocking any other provider's skills.
        expect((await ComputeMode.resolve()).mode).toBe("byok")
        expect(await offered()).toEqual([])
      },
    })
  })

  test("in managed, a credentialed provider's skill is still not offered — mode governs, not providers", async () => {
    // Regression guard for the filter keying off `providers` (the credentialed
    // set, reported verbatim in every mode) instead of `mode`. Lambda IS
    // credentialed here — ComputeMode.resolve().providers is non-empty — but
    // billing.compute forces the managed override and the probe confirms
    // managed is funded, so mode is "managed", not "byok". A filter that
    // trusted `providers` would offer lambda's skill anyway; this must not.
    stub(true)
    process.env["LAMBDA_API_KEY"] = "k"
    await using tmp = await project(async (dir) => {
      await Bun.write(path.join(dir, "openscience.json"), JSON.stringify({ billing: { compute: "managed" } }))
    })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const resolved = await ComputeMode.resolve()
        expect(resolved.mode).toBe("managed")
        expect(resolved.providers).toEqual(["lambda"])
        expect(await offered()).toEqual([])
      },
    })
  })

  test("in none, no BYOK provider skill is offered", async () => {
    stub(false)
    await using tmp = await project(async () => {})
    const names = await Instance.provide({ directory: tmp.path, fn: offered })
    expect(names).toEqual([])
  })

  test("non-compute skills are unaffected in every mode", async () => {
    for (const managed of [true, false]) {
      stub(managed)
      ComputeMode.invalidate()
      await using tmp = await project(async () => {})
      expect(await Instance.provide({ directory: tmp.path, fn: nonComputeVisible })).toBe(true)
    }

    // byok: a credentialed provider must not affect a skill outside its scope either.
    stub(false)
    process.env["LAMBDA_API_KEY"] = "k"
    ComputeMode.invalidate()
    await using byok = await project(async () => {})
    expect(await Instance.provide({ directory: byok.path, fn: nonComputeVisible })).toBe(true)
  })

  test("cloud-compute skills that map to no panel provider are never hidden", async () => {
    stub(false)
    await using tmp = await project(async () => {})
    expect(await Instance.provide({ directory: tmp.path, fn: tinkerVisible })).toBe(true)

    // byok: a credentialed provider must not hide a skill outside ComputeMode.SKILLS either.
    process.env["LAMBDA_API_KEY"] = "k"
    ComputeMode.invalidate()
    await using byok = await project(async () => {})
    expect(await Instance.provide({ directory: byok.path, fn: tinkerVisible })).toBe(true)
  })

  test("a credential added between two init() calls changes the catalog on the second", async () => {
    stub(false)
    await using tmp = await project(async () => {})
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        expect(await offered()).toEqual([])
        process.env["TENSORPOOL_KEY"] = "tp-late"
        expect(await offered()).toEqual(["tensorpool-gpu-cloud"])
      },
    })
  })

  test("credentialed: SkillTool and compute_status agree lambda is the usable provider", async () => {
    stub(false)
    process.env["LAMBDA_API_KEY"] = "k"
    await using tmp = await project(async () => {})
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        expect(await offered()).toEqual(["lambda-labs-gpu-cloud"])
        expect((await computeStatus()).providers).toEqual(["lambda"])
      },
    })
  })

  test("no credentials: SkillTool and compute_status agree nothing is usable", async () => {
    stub(false)
    await using tmp = await project(async () => {})
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        expect(await offered()).toEqual([])
        expect((await computeStatus()).mode).toBe("none")
      },
    })
  })
})
