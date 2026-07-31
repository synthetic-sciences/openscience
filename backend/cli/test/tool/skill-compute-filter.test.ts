import { test, expect, describe, beforeEach, afterEach } from "bun:test"
import path from "path"
import fs from "fs/promises"
import { SkillTool } from "../../src/tool/skill"
import { ComputeMode } from "../../src/compute/mode"
import { Instance } from "../../src/project/instance"
import { Global } from "../../src/global"
import { tmpdir } from "../fixture/fixture"

const ENV = ["LAMBDA_API_KEY", "RUNPOD_API_KEY", "MODAL_TOKEN_ID", "MODAL_TOKEN_SECRET", "TENSORPOOL_KEY"]
const SESSION = path.join(Global.Path.data, "openscience-session.json")
const realFetch = globalThis.fetch

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
    const result = await tool
      .execute({ category }, {
        sessionID: "s",
        messageID: "m",
        agent: "research",
        abort: new AbortController().signal,
        messages: [],
        metadata: () => {},
        ask: async () => {},
      } as never)
      .catch(() => undefined)
    if (result) found.push(result.output)
  }
  const text = found.join("\n")
  return [...ComputeMode.SKILLS].filter((name) => text.includes(`**${name}**`)).sort()
}

async function nonComputeVisible(): Promise<boolean> {
  const tool = await SkillTool.init({})
  const result = await tool.execute({ category: "chemistry" }, {
    sessionID: "s",
    messageID: "m",
    agent: "research",
    abort: new AbortController().signal,
    messages: [],
    metadata: () => {},
    ask: async () => {},
  } as never)
  return result.output.includes("**rdkit**")
}

async function tinkerVisible(): Promise<boolean> {
  const tool = await SkillTool.init({})
  const result = await tool.execute({ category: "cloud-compute" }, {
    sessionID: "s",
    messageID: "m",
    agent: "research",
    abort: new AbortController().signal,
    messages: [],
    metadata: () => {},
    ask: async () => {},
  } as never)
  return result.output.includes("**tinker-fine-tuning**")
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

  test("in managed, no BYOK provider skill is offered", async () => {
    stub(true)
    await using tmp = await project(async () => {})
    const names = await Instance.provide({ directory: tmp.path, fn: offered })
    expect(names).toEqual([])
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
  })

  test("cloud-compute skills that map to no panel provider are never hidden", async () => {
    stub(false)
    await using tmp = await project(async () => {})
    expect(await Instance.provide({ directory: tmp.path, fn: tinkerVisible })).toBe(true)
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

  test("SkillTool.init and compute_status never disagree about usable providers", async () => {
    stub(false)
    process.env["LAMBDA_API_KEY"] = "k"
    await using tmp = await project(async () => {})
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const state = await ComputeMode.resolve()
        const names = await offered()
        const expected = state.providers.flatMap((id) => ComputeMode.PROVIDERS[id].skills)
        expect(names.sort()).toEqual([...new Set(expected)].sort())
      },
    })
  })
})
