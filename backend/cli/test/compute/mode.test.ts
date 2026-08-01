import { test, expect, afterEach, beforeEach, describe } from "bun:test"
import path from "path"
import fs from "fs/promises"
import { ComputeMode } from "../../src/compute/mode"
import { Instance } from "../../src/project/instance"
import { Global } from "../../src/global"
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

const OPTIONS_URL = "/api/compute/options"
const SESSION = path.join(Global.Path.data, "openscience-session.json")
const realFetch = globalThis.fetch
const realNow = Date.now

/** Record of every URL the resolver fetched, so "the call is skipped" is a
 *  positive assertion rather than an absence of failure. */
let calls: string[] = []

function stubOptions(body: unknown, status = 200) {
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input instanceof Request ? input.url : input)
    calls.push(url)
    if (!url.includes(OPTIONS_URL)) return realFetch(input as never)
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
  }) as typeof fetch
}

async function signIn() {
  await fs.mkdir(Global.Path.data, { recursive: true })
  await Bun.write(SESSION, JSON.stringify({ api_key: "thk_test.secret", user_id: "u1" }))
}

const MANAGED_ON = {
  options: [],
  providers: [
    { provider: "lambda", has_byok: false, has_operator: true, funding: "managed", count: 3 },
    { provider: "vast", has_byok: false, has_operator: false, funding: "unavailable", count: 0 },
  ],
  resell_enabled: true,
  cli_effective_balance_cents: 1234,
}

const MANAGED_OFF = {
  options: [],
  providers: [{ provider: "lambda", has_byok: false, has_operator: false, funding: "unavailable", count: 0 }],
  resell_enabled: false,
  cli_effective_balance_cents: 1234,
}

describe("ComputeMode.resolve", () => {
  beforeEach(() => {
    clearEnv()
    calls = []
    ComputeMode.invalidate()
  })

  afterEach(async () => {
    globalThis.fetch = realFetch
    Date.now = realNow
    await fs.rm(SESSION, { force: true }).catch(() => {})
  })

  test("a usable provider resolves to byok WITHOUT calling the availability endpoint", async () => {
    await signIn()
    stubOptions(MANAGED_ON)
    process.env["LAMBDA_API_KEY"] = "k"
    const result = await withSkills(["lambda-labs-gpu-cloud"], () => ComputeMode.resolve())
    expect(result.mode).toBe("byok")
    expect(result.providers).toEqual(["lambda"])
    expect(result.balance).toBeUndefined()
    expect(calls.filter((url) => url.includes(OPTIONS_URL))).toEqual([])
  })

  test("no keys plus managed available resolves to managed, with the balance", async () => {
    await signIn()
    stubOptions(MANAGED_ON)
    const result = await withSkills(["lambda-labs-gpu-cloud"], () => ComputeMode.resolve())
    expect(result.mode).toBe("managed")
    expect(result.managed).toBe(true)
    expect(result.balance).toBe(12.34)
  })

  test("no keys plus managed unavailable resolves to none", async () => {
    await signIn()
    stubOptions(MANAGED_OFF)
    const result = await withSkills(["lambda-labs-gpu-cloud"], () => ComputeMode.resolve())
    expect(result.mode).toBe("none")
    expect(result.managed).toBe(false)
    expect(result.balance).toBeUndefined()
  })

  test("a failing availability call resolves to none, not managed", async () => {
    await signIn()
    globalThis.fetch = (async (input: string | URL | Request): Promise<Response> => {
      throw new Error("network down")
    }) as typeof fetch
    const result = await withSkills([], () => ComputeMode.resolve())
    expect(result.mode).toBe("none")
    expect(result.managed).toBe(false)
  })

  test("a non-ok availability response resolves to none", async () => {
    await signIn()
    stubOptions({ detail: "unauthorized" }, 401)
    const result = await withSkills([], () => ComputeMode.resolve())
    expect(result.mode).toBe("none")
  })

  test("no session means managed is unavailable and no call is made", async () => {
    await fs.rm(SESSION, { force: true }).catch(() => {})
    stubOptions(MANAGED_ON)
    const result = await withSkills([], () => ComputeMode.resolve())
    expect(result.mode).toBe("none")
    expect(calls.filter((url) => url.includes(OPTIONS_URL))).toEqual([])
  })

  test("a key with no skill still resolves to byok and skips the availability call", async () => {
    await signIn()
    stubOptions(MANAGED_ON)
    process.env["RUNPOD_API_KEY"] = "rpa_x"
    const result = await withSkills([], () => ComputeMode.resolve())
    expect(result.mode).toBe("byok")
    expect(result.providers).toEqual(["runpod"])
    expect(calls.filter((url) => url.includes(OPTIONS_URL))).toEqual([])
  })

  test("a byok resolution leaves managed availability UNMEASURED, not false", async () => {
    // The byok arms deliberately skip the availability probe — that skip is the
    // performance win. `managed: false` there would be an unmeasured claim, and
    // the tool prints it as a fact ("managed available: no").
    await signIn()
    stubOptions(MANAGED_ON)
    process.env["LAMBDA_API_KEY"] = "k"
    const result = await withSkills(["lambda-labs-gpu-cloud"], () => ComputeMode.resolve())
    expect(result.mode).toBe("byok")
    expect(result.managed).toBeUndefined()
    expect(calls.filter((url) => url.includes(OPTIONS_URL))).toEqual([])
  })

  test("a probed resolution reports availability as a measured boolean", async () => {
    await signIn()
    stubOptions(MANAGED_ON)
    expect((await withSkills([], () => ComputeMode.resolve())).managed).toBe(true)
    ComputeMode.invalidate()
    stubOptions(MANAGED_OFF)
    expect((await withSkills([], () => ComputeMode.resolve())).managed).toBe(false)
  })

  test("with no override, every arm records origin 'environment'", async () => {
    await signIn()
    stubOptions(MANAGED_ON)
    process.env["LAMBDA_API_KEY"] = "k"
    expect((await withSkills(["lambda-labs-gpu-cloud"], () => ComputeMode.resolve())).origin).toBe("environment")
    clearEnv()
    ComputeMode.invalidate()
    expect((await withSkills([], () => ComputeMode.resolve())).origin).toBe("environment")
    ComputeMode.invalidate()
    stubOptions(MANAGED_OFF)
    expect((await withSkills([], () => ComputeMode.resolve())).origin).toBe("environment")
  })

  test("the availability answer is cached within the TTL", async () => {
    await signIn()
    stubOptions(MANAGED_ON)
    let now = realNow()
    Date.now = () => now
    await withSkills([], async () => {
      await ComputeMode.resolve()
      now += 4_999 // still inside the 5s TTL
      await ComputeMode.resolve()
    })
    expect(calls.filter((url) => url.includes(OPTIONS_URL)).length).toBe(1)
  })

  test("the cache expires once the TTL elapses, forcing a re-probe", async () => {
    await signIn()
    stubOptions(MANAGED_ON)
    let now = realNow()
    Date.now = () => now
    await withSkills([], async () => {
      const first = await ComputeMode.resolve()
      expect(first.mode).toBe("managed")
      now += 5_001 // past the 5s TTL — the cached verdict must be treated as stale
      stubOptions(MANAGED_OFF)
      const second = await ComputeMode.resolve()
      expect(second.mode).toBe("none")
    })
    expect(calls.filter((url) => url.includes(OPTIONS_URL)).length).toBe(2)
  })

  test("invalidate() drops the cache", async () => {
    await signIn()
    stubOptions(MANAGED_ON)
    await withSkills([], async () => {
      await ComputeMode.resolve()
      ComputeMode.invalidate()
      await ComputeMode.resolve()
    })
    expect(calls.filter((url) => url.includes(OPTIONS_URL)).length).toBe(2)
  })
})

describe("ComputeMode.resolve override", () => {
  beforeEach(() => {
    clearEnv()
    calls = []
    ComputeMode.invalidate()
  })
  afterEach(async () => {
    globalThis.fetch = realFetch
    await fs.rm(SESSION, { force: true }).catch(() => {})
  })

  /** Same tmpdir fixture as withSkills, plus an openscience.json setting
   *  billing.compute. */
  async function withOverride<T>(mode: "byok" | "managed", skills: string[], fn: () => Promise<T>): Promise<T> {
    await using tmp = await tmpdir({
      git: true,
      init: async (dir) => {
        for (const name of skills) {
          await Bun.write(
            path.join(dir, ".openscience", "skill", name, "SKILL.md"),
            `---\nname: ${name}\ndescription: Test fixture for ${name}.\ncategory: cloud-compute\n---\n\n# ${name}\n`,
          )
        }
        await Bun.write(path.join(dir, "openscience.json"), JSON.stringify({ billing: { compute: mode } }))
      },
    })
    return Instance.provide({ directory: tmp.path, fn })
  }

  test("override byok with a usable provider stays byok", async () => {
    await signIn()
    stubOptions(MANAGED_ON)
    process.env["LAMBDA_API_KEY"] = "k"
    const result = await withOverride("byok", ["lambda-labs-gpu-cloud"], () => ComputeMode.resolve())
    expect(result.mode).toBe("byok")
  })

  test("override byok with NO usable provider narrows to none, never managed", async () => {
    await signIn()
    stubOptions(MANAGED_ON)
    const result = await withOverride("byok", ["lambda-labs-gpu-cloud"], () => ComputeMode.resolve())
    expect(result.mode).toBe("none")
    expect(calls.filter((url) => url.includes(OPTIONS_URL))).toEqual([])
  })

  test("override managed with managed unavailable narrows to none", async () => {
    await signIn()
    stubOptions(MANAGED_OFF)
    const result = await withOverride("managed", [], () => ComputeMode.resolve())
    expect(result.mode).toBe("none")
  })

  test("override managed with a usable provider still narrows to none when managed is unavailable", async () => {
    await signIn()
    stubOptions(MANAGED_OFF)
    process.env["LAMBDA_API_KEY"] = "k"
    const result = await withOverride("managed", ["lambda-labs-gpu-cloud"], () => ComputeMode.resolve())
    expect(result.mode).toBe("none")
    // The credential is real — it's just not the funded path under a forced
    // managed override, so it must still be reported, not hidden.
    expect(result.providers).toEqual(["lambda"])
  })

  test("an override stamps the origin with the setting that forced the mode", async () => {
    // A caller cannot otherwise tell "managed because the environment says so"
    // (where connecting a key flips to byok next call) from "managed because
    // billing.compute pins it" (where connecting a key changes nothing) — and
    // those two states need opposite advice.
    await signIn()
    stubOptions(MANAGED_ON)
    process.env["LAMBDA_API_KEY"] = "k"
    expect((await withOverride("byok", ["lambda-labs-gpu-cloud"], () => ComputeMode.resolve())).origin).toBe(
      "config:byok",
    )
    ComputeMode.invalidate()
    expect((await withOverride("managed", ["lambda-labs-gpu-cloud"], () => ComputeMode.resolve())).origin).toBe(
      "config:managed",
    )
    // Narrowed to "none" the origin still has to name the setting that narrowed it.
    ComputeMode.invalidate()
    stubOptions(MANAGED_OFF)
    const narrowed = await withOverride("managed", ["lambda-labs-gpu-cloud"], () => ComputeMode.resolve())
    expect(narrowed.mode).toBe("none")
    expect(narrowed.origin).toBe("config:managed")
  })

  test("override managed beats a usable provider when managed IS available", async () => {
    await signIn()
    stubOptions(MANAGED_ON)
    process.env["LAMBDA_API_KEY"] = "k"
    const result = await withOverride("managed", ["lambda-labs-gpu-cloud"], () => ComputeMode.resolve())
    expect(result.mode).toBe("managed")
  })
})

describe("ComputeMode.offered", () => {
  beforeEach(() => {
    clearEnv()
    calls = []
    ComputeMode.invalidate()
  })
  afterEach(async () => {
    globalThis.fetch = realFetch
    await fs.rm(SESSION, { force: true }).catch(() => {})
  })

  /** Prove the equivalence by construction rather than by example: across
   *  every combination of credential presence, override, and managed
   *  availability, `offered()` must equal `resolve()`'s providers' skills
   *  exactly when the resolved mode is "byok" (empty otherwise, including
   *  when byok's providers carry no catalogued skill), and must never touch
   *  the network — a positive assertion (an empty recorded call list), not
   *  merely the absence of a thrown error. */
  test("offered() equals resolve()'s byok providers' skills when mode is byok, empty otherwise, and never calls the availability endpoint", async () => {
    const overrides = [undefined, "byok", "managed"] as const
    for (const credential of [true, false]) {
      for (const override of overrides) {
        for (const managedAvailable of [true, false]) {
          clearEnv()
          calls = []
          ComputeMode.invalidate()
          await signIn()
          stubOptions(managedAvailable ? MANAGED_ON : MANAGED_OFF)
          if (credential) process.env["LAMBDA_API_KEY"] = "k"

          await using tmp = await tmpdir({
            git: true,
            init: async (dir) => {
              await Bun.write(
                path.join(dir, ".openscience", "skill", "lambda-labs-gpu-cloud", "SKILL.md"),
                `---\nname: lambda-labs-gpu-cloud\ndescription: Test fixture.\ncategory: cloud-compute\n---\n\n# lambda-labs-gpu-cloud\n`,
              )
              if (override) {
                await Bun.write(path.join(dir, "openscience.json"), JSON.stringify({ billing: { compute: override } }))
              }
            },
          })

          await Instance.provide({
            directory: tmp.path,
            fn: async () => {
              const state = `credential=${credential} override=${override ?? "unset"} managedAvailable=${managedAvailable}`
              const resolved = await ComputeMode.resolve()
              calls = [] // isolate the assertion below to offered()'s own network usage
              // resolve() may have just warmed the 5s availability cache — without
              // dropping it, a probe-hitting offered() would be served from cache
              // and never reach fetch, so the "no network call" assertion below
              // would pass even for an implementation that calls available().
              ComputeMode.invalidate()
              const result = await ComputeMode.offered()

              expect(calls.filter((url) => url.includes(OPTIONS_URL))).toEqual([])

              if (resolved.mode === "byok") {
                expect(result.size, state).toBeGreaterThan(0)
                expect([...result].sort(), state).toEqual(
                  resolved.providers.flatMap((id) => ComputeMode.PROVIDERS[id].skills).sort(),
                )
              } else {
                expect(result.size, state).toBe(0)
              }
            },
          })
        }
      }
    }
  })
})
