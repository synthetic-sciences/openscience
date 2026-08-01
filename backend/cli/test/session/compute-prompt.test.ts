import { test, expect, describe } from "bun:test"
import path from "path"
import { ComputeMode } from "../../src/compute/mode"

const root = path.join(import.meta.dir, "..", "..", "src")

async function sources() {
  const globs = ["session/**/*.{ts,txt}", "agent/prompt/*.txt"]
  const files = (
    await Promise.all(
      globs.map((pattern) =>
        Array.fromAsync(new Bun.Glob(pattern).scan({ cwd: root, absolute: true, onlyFiles: true })),
      ),
    )
  ).flat()
  return Promise.all(files.map(async (file) => [file, await Bun.file(file).text()] as const))
}

/** Every primary agent that can send a user down a compute path. `sources()`
 *  globs the whole prompt tree but the assertions below used to hardcode
 *  research.txt, which made them structurally unable to catch the same defect
 *  in a sibling prompt. */
const COMPUTE_AGENTS = ["research", "biology", "physics", "ml"]

async function agents() {
  return Promise.all(
    COMPUTE_AGENTS.map(async (name) => {
      const file = path.join(root, "agent", "prompt", `${name}.txt`)
      return [file, await Bun.file(file).text()] as const
    }),
  )
}

/** Markdown bullets with continuation lines folded in, so a rule about what an
 *  instruction says sees the whole instruction rather than its first line. */
function bullets(text: string) {
  const out: string[] = []
  let open = false
  for (const line of text.split("\n")) {
    if (/^\s*[-*] /.test(line)) {
      out.push(line.trim())
      open = true
      continue
    }
    if (open && /^\s+\S/.test(line)) {
      out[out.length - 1] += " " + line.trim()
      continue
    }
    open = false
  }
  return out
}

describe("compute prompt text", () => {
  test("every COMPUTE_AGENTS prompt exists and is non-empty", async () => {
    // The bans below are only worth as much as the file set they run over — a
    // renamed prompt must fail loudly, not silently drop out of coverage.
    const loaded = await agents()
    expect(loaded.map(([file]) => path.relative(root, file))).toEqual(
      COMPUTE_AGENTS.map((name) => path.join("agent", "prompt", `${name}.txt`)),
    )
    for (const [file, text] of loaded) expect(text.length, file).toBeGreaterThan(100)
  })

  /**
   * Instructions no compute-capable prompt may carry.
   *
   * The restart pattern is phrase-shaped, not word-shaped, on purpose: "Do not
   * restart on a missing tool" is a legitimate instruction and so is stating
   * that a newly connected key needs NO restart. What is banned is telling the
   * user to restart to pick a credential up — which contradicts a tested design
   * claim (compute-status.test.ts, "a credential connected between two calls
   * changes the answer, no restart"): the Compute and Credentials panels call
   * applyComputeEnv/applyCredentialEnv on save, and a key added in the hosted
   * dashboard lands via refreshIfStale's background sync on the next message.
   */
  const BANNED: Array<[string, RegExp]> = [
    ["atlas compute:up", /compute:up/],
    ["telling the user to restart", /(?:then|and)\s+restart|restart\s+openscience|restart\s+the\s+(?:cli|session)/i],
  ]

  test("every compute-capable agent prompt is free of the banned instructions", async () => {
    const loaded = await agents()
    const hits = BANNED.flatMap(([label, pattern]) =>
      loaded.filter(([, text]) => pattern.test(text)).map(([file]) => `${path.relative(root, file)}: ${label}`),
    )
    expect(hits).toEqual([])
  })

  test("no agent prompt tells the agent to load a mode-gated compute skill unconditionally", async () => {
    // ComputeMode.SKILLS names are hidden from the catalog unless the provider
    // is credentialed. An unconditional "Load: `modal-research-gpu`" both
    // overrides whatever compute_status just returned and points at a skill the
    // filter may have removed, so any bullet naming one has to be gated on byok.
    const gated = [...ComputeMode.SKILLS]
    const hits = (await agents()).flatMap(([file, text]) =>
      bullets(text)
        .filter((bullet) => /\bload\b/i.test(bullet))
        .filter((bullet) => gated.some((skill) => bullet.includes(skill)))
        .filter((bullet) => !bullet.includes("byok"))
        .map((bullet) => `${path.relative(root, file)}: ${bullet}`),
    )
    expect(hits).toEqual([])
  })

  test("no prompt or session source references atlas compute:up", async () => {
    const hits = (await sources()).filter(([, text]) => text.includes("compute:up"))
    expect(hits.map(([file]) => path.relative(root, file))).toEqual([])
  })

  test("the file set is non-empty and covers both prompt trees", async () => {
    const files = (await sources()).map(([file]) => path.relative(root, file))
    expect(files.length).toBeGreaterThan(20)
    expect(files).toContain("session/prompt.ts")
    expect(files).toContain("agent/prompt/research.txt")
  })

  test("no prompt uses atlas doctor as the compute availability signal", async () => {
    // `atlas doctor` legitimately reports whether the atlas CLI is present and
    // authenticated (research.txt uses it that way before loading graph state).
    // What it does NOT report is anything about compute — so any paragraph that
    // mentions both compute and `atlas doctor` is reading a signal that isn't there.
    const hits = (await sources()).filter(([, text]) =>
      text.split(/\n\s*\n/).some((para) => /atlas doctor/i.test(para) && /\bcompute\b/i.test(para)),
    )
    expect(hits.map(([file]) => path.relative(root, file))).toEqual([])
  })

  test("agent prompts point at compute_status for GPU funding", async () => {
    const text = await Bun.file(path.join(root, "agent", "prompt", "research.txt")).text()
    expect(text).toContain("compute_status")
  })

  test("modal skill mentions in research.txt resolve against ComputeMode.PROVIDERS", async () => {
    // `modal` (bare, backticked or not) is a directory name, not a skill name —
    // the frontmatter `name` values the skill tool actually resolves on are
    // modal-serverless-gpu, modal-ml-training, modal-research-gpu, which is
    // exactly ComputeMode.PROVIDERS.modal.skills. Pull every lowercase
    // modal*-shaped token out of the prompt (skill tokens are always
    // lowercase-hyphenated; "Modal" the company name in prose is capitalized
    // and so never matches) and check it against that list — not the other way
    // around, since the map trivially agrees with itself.
    const text = await Bun.file(path.join(root, "agent", "prompt", "research.txt")).text()
    const tokens = [...new Set(text.match(/\bmodal[a-z-]*\b/g) ?? [])]
    expect(tokens.length).toBeGreaterThan(0)
    const valid = new Set(ComputeMode.PROVIDERS.modal.skills)
    expect(tokens.filter((token) => !valid.has(token))).toEqual([])
  })

  test("the compute reminder points at compute_status and carries no mode", async () => {
    const text = await Bun.file(path.join(root, "session", "prompt.ts")).text()
    expect(text).toContain("compute_status")
    // The reminder must be stateless — a mode baked into an injected string is
    // false the moment the user connects a key mid-session.
    expect(text).not.toContain("Compute spend is set to")
  })

  test("computeBillingMode is gone and nothing imports it", async () => {
    const gate = await Bun.file(path.join(root, "session", "billing-gate.ts")).text()
    expect(gate).not.toContain("computeBillingMode")
    const files = await Array.fromAsync(new Bun.Glob("**/*.ts").scan({ cwd: root, absolute: true, onlyFiles: true }))
    const importers = (
      await Promise.all(
        files.map(async (file) => ((await Bun.file(file).text()).includes("computeBillingMode") ? file : undefined)),
      )
    ).filter(Boolean)
    expect(importers).toEqual([])
  })

  test("the billing.compute config description no longer claims 'Unset = byok'", async () => {
    const text = await Bun.file(path.join(root, "config", "config.ts")).text()
    // Scoped to the compute field's own description, not the whole file —
    // billing.llm's untouched description already contains "auto-detect", so
    // an unscoped scan would pass even if compute's description regressed to
    // something like "Defaults to byok when unset".
    const start = text.indexOf("compute: z")
    expect(start).toBeGreaterThan(-1)
    const end = text.indexOf("username: z", start)
    expect(end).toBeGreaterThan(start)
    const description = text.slice(start, end)
    expect(description).not.toContain("Unset = byok")
    expect(description).toContain("auto-detect")
  })
})
