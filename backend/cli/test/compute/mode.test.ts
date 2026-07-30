import { test, expect, afterEach, describe } from "bun:test"
import path from "path"
import { ComputeMode } from "../../src/compute/mode"
import { Instance } from "../../src/project/instance"
import { tmpdir } from "../fixture/fixture"

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

function clearEnv() {
  for (const name of ENV) delete process.env[name]
}

afterEach(clearEnv)

/** A tmpdir project seeded with real SKILL.md files, so Skill.all() finds them
 *  without a network catalog. `OPENSCIENCE_DISABLE_BUNDLED_SKILLS` in preload.ts
 *  keeps the dev skills/ dir and the server index out, so the test controls the
 *  catalog exactly. */
async function withSkills<T>(names: string[], fn: () => T): Promise<T> {
  await using tmp = await tmpdir({
    git: true,
    init: async (dir) => {
      for (const name of names) {
        await Bun.write(
          path.join(dir, ".openscience", "skill", name, "SKILL.md"),
          `---\nname: ${name}\ndescription: Test fixture for ${name}.\ncategory: cloud-compute\n---\n\n# ${name}\n`,
        )
      }
    },
  })
  return Instance.provide({ directory: tmp.path, fn })
}

describe("ComputeMode.usable", () => {
  test("a provider with a key and a skill is usable", async () => {
    clearEnv()
    process.env["LAMBDA_API_KEY"] = "secret_abc"
    const result = await withSkills(["lambda-labs-gpu-cloud"], () => ComputeMode.usable())
    expect(result).toEqual(["lambda"])
  })

  test("the alternate env spelling also counts", async () => {
    clearEnv()
    process.env["LAMBDA_LABS_API_KEY"] = "secret_abc"
    const result = await withSkills(["lambda-labs-gpu-cloud"], () => ComputeMode.usable())
    expect(result).toEqual(["lambda"])
  })

  test("a key with NO catalogued skill IS usable — the agent drives the provider API directly", async () => {
    clearEnv()
    process.env["RUNPOD_API_KEY"] = "rpa_abc"
    expect(await withSkills([], () => ComputeMode.usable())).toEqual(["runpod"])
  })

  test("a catalogued skill with NO key is not usable", async () => {
    clearEnv()
    const result = await withSkills(["lambda-labs-gpu-cloud"], () => ComputeMode.usable())
    expect(result).toEqual([])
  })

  test("modal needs BOTH token vars — id alone is not a key", async () => {
    clearEnv()
    process.env["MODAL_TOKEN_ID"] = "ak-abc"
    const result = await withSkills(["modal-serverless-gpu"], () => ComputeMode.usable())
    expect(result).toEqual([])
  })

  test("modal with both token vars is usable", async () => {
    clearEnv()
    process.env["MODAL_TOKEN_ID"] = "ak-abc"
    process.env["MODAL_TOKEN_SECRET"] = "as-def"
    const result = await withSkills(["modal-serverless-gpu"], () => ComputeMode.usable())
    expect(result).toEqual(["modal"])
  })

  test("PROVIDERS pins the exact skill names the catalog filter matches on", async () => {
    expect([...ComputeMode.SKILLS].sort()).toEqual(
      [
        "lambda-labs-gpu-cloud",
        "modal-ml-training",
        "modal-research-gpu",
        "modal-serverless-gpu",
        "prime-intellect-lab",
        "tensorpool-gpu-cloud",
      ].sort(),
    )
    expect(ComputeMode.PROVIDERS["runpod"].skills).toEqual([])
    expect(ComputeMode.PROVIDERS["vast"].skills).toEqual([])
  })

  test("an empty-string key does not count as set", async () => {
    clearEnv()
    process.env["TENSORPOOL_KEY"] = ""
    const result = await withSkills(["tensorpool-gpu-cloud"], () => ComputeMode.usable())
    expect(result).toEqual([])
  })

  test("every provider resolves in isolation, given its own skill", async () => {
    const cases: Array<[string, Record<string, string>, string]> = [
      ["modal", { MODAL_TOKEN_ID: "ak-a", MODAL_TOKEN_SECRET: "as-b" }, "modal-serverless-gpu"],
      ["lambda", { LAMBDA_API_KEY: "k" }, "lambda-labs-gpu-cloud"],
      ["tensorpool", { TENSORPOOL_KEY: "k" }, "tensorpool-gpu-cloud"],
      ["prime", { PRIME_API_KEY: "k" }, "prime-intellect-lab"],
      ["runpod", { RUNPOD_API_KEY: "k" }, "runpod-gpu-cloud"],
      ["vast", { VAST_API_KEY: "k" }, "vast-ai-gpu-cloud"],
    ]
    for (const [id, env, skill] of cases) {
      clearEnv()
      Object.assign(process.env, env)
      const result = await withSkills([skill], () => ComputeMode.usable())
      expect(result).toEqual([id])
    }
  })

  test("SKILLS covers every name in PROVIDERS and nothing else", () => {
    const required = [
      "modal-serverless-gpu",
      "modal-ml-training",
      "modal-research-gpu",
      "lambda-labs-gpu-cloud",
      "tensorpool-gpu-cloud",
      "prime-intellect-lab",
    ]
    expect([...ComputeMode.SKILLS].sort()).toEqual([...required].sort())
    expect(ComputeMode.SKILLS.size).toBe(required.length)
  })

  test("a key injected after the first call is seen on the next call", async () => {
    clearEnv()
    await withSkills(["lambda-labs-gpu-cloud"], async () => {
      expect(await ComputeMode.usable()).toEqual([])
      process.env["LAMBDA_API_KEY"] = "secret_late"
      expect(await ComputeMode.usable()).toEqual(["lambda"])
    })
  })

  test("providers keyed together return in PROVIDERS declaration order, not set order", async () => {
    clearEnv()
    process.env["VAST_API_KEY"] = "v"
    process.env["MODAL_TOKEN_ID"] = "ak-a"
    process.env["MODAL_TOKEN_SECRET"] = "as-b"
    process.env["LAMBDA_API_KEY"] = "l"
    const result = await withSkills(["vast-ai-gpu-cloud", "modal-serverless-gpu", "lambda-labs-gpu-cloud"], () =>
      ComputeMode.usable(),
    )
    expect(result).toEqual(["modal", "lambda", "vast"])
  })
})
