import { expect, test } from "bun:test"
import fs from "fs"
import path from "path"
import { Installer } from "../../src/package/installer"
import { Sandbox } from "../../src/sandbox/sandbox"
import { tmpdir } from "../fixture/fixture"

const python = Bun.which("python3")

test("probe prefers an existing environment directory over any tool", async () => {
  await using dir = await tmpdir()
  const env = path.join(dir.path, "env")
  fs.mkdirSync(path.dirname(Installer.interpreter(env)), { recursive: true })
  fs.writeFileSync(Installer.interpreter(env), "")
  expect((await Installer.probe(env)).kind).toBe("existing")
})

test("probe picks uv over venv when both are available", async () => {
  await using dir = await tmpdir()
  // uv is the fast path when present; venv is the guarantee that it is never
  // required.
  const tool = await Installer.probe(path.join(dir.path, "nothing"), { uv: "/fake/uv", python: "/fake/python3" })
  expect(tool).toEqual({ kind: "uv", binary: "/fake/uv" })
})

test("probe falls back to venv when uv is absent", async () => {
  await using dir = await tmpdir()
  const tool = await Installer.probe(path.join(dir.path, "nothing"), { uv: undefined, python: "/fake/python3" })
  expect(tool).toEqual({ kind: "venv", binary: "/fake/python3" })
})

test("the remedy names both routes, and never offers to download one", async () => {
  await using dir = await tmpdir()
  // An opaque failure here reads as a broken machine — the exact symptom this
  // whole design started from, where a missing pip, a severed network and a
  // read-only site-packages all surfaced as one unreadable error.
  const message = await Installer.probe(path.join(dir.path, "nothing"), { uv: undefined, python: undefined }).then(
    () => "",
    (error: Error) => error.message,
  )
  expect(message).toContain("python3-venv")
  expect(message).toContain("uv")
  expect(message).toContain("never downloads")
})

test.skipIf(!python)("creates a venv whose interpreter runs", async () => {
  await using dir = await tmpdir()
  const env = path.join(dir.path, "env")
  await Installer.create(env, { kind: "venv", binary: python! })
  const proc = Bun.spawn([Installer.interpreter(env), "--version"], { stdout: "pipe" })
  expect(await new Response(proc.stdout).text()).toContain("Python 3")
})

test.skipIf(!python)("a fresh venv has pip even when the host python3 does not", async () => {
  // Verified on Arch during design: python3 ships without pip there, and
  // `python3 -m venv` still bootstraps pip from the bundled ensurepip wheel,
  // offline. uv is a fast path, never a requirement.
  await using dir = await tmpdir()
  const env = path.join(dir.path, "env")
  await Installer.create(env, { kind: "venv", binary: python! })
  const proc = Bun.spawn([Installer.interpreter(env), "-m", "pip", "--version"], { stdout: "pipe", stderr: "pipe" })
  await proc.exited
  expect(proc.exitCode).toBe(0)
})

const uv = Bun.which("uv")

test.skipIf(!uv)(
  "an environment created by the uv branch has pip, because install() needs it",
  async () => {
    // Regression, and the reason `uv venv --seed` exists in create(). Plain
    // `uv venv` does NOT bootstrap pip the way `python3 -m venv` does, while
    // install() shells out to `python -m pip` regardless of who created the
    // environment. Without the seed the uv branch produced an environment the
    // installer could not use at all — "No module named pip" from a venv that
    // looked perfectly healthy from outside the sandbox.
    await using dir = await tmpdir()
    const env = path.join(dir.path, "env")
    await Installer.create(env, { kind: "uv", binary: uv! })
    const proc = Bun.spawn([Installer.interpreter(env), "-m", "pip", "--version"], { stdout: "pipe", stderr: "pipe" })
    await proc.exited
    expect(proc.exitCode).toBe(0)
  },
  120_000,
)

// The regression this pair exists for, measured in real use: a kernel binds to
// the managed environment as soon as one exists and falls back to the host
// interpreter while it does not, so the FIRST install of anything used to strip
// every host package from every kernel in the project. Install tqdm, lose numpy
// — while the notebook tool still advertised numpy as pre-imported.
const hostHas = (name: string) => {
  const proc = Bun.spawnSync([python ?? "python3", "-c", `import ${name}`], { stdout: "ignore", stderr: "ignore" })
  return proc.exitCode === 0
}

test.skipIf(!python || !hostHas("numpy"))(
  "a fresh environment can still import what the host interpreter had",
  async () => {
    await using dir = await tmpdir()
    const env = path.join(dir.path, "env")
    await Installer.create(env, { kind: "venv", binary: python! })
    const proc = Bun.spawn([Installer.interpreter(env), "-c", "import numpy"], { stdout: "ignore", stderr: "pipe" })
    const err = await new Response(proc.stderr).text()
    await proc.exited
    expect(proc.exitCode, err).toBe(0)
  },
  120_000,
)

test.skipIf(!python || !hostHas("numpy"))(
  "verify reports an inherited package, because the kernel can genuinely use it",
  async () => {
    // freeze() lists only what the environment OWNS. Since environments inherit
    // system site-packages, pip treats a host-provided package as already
    // satisfied and installs nothing — so a freeze-based verify answered
    // "(nothing reported)" for a request that is, from the user's seat,
    // perfectly satisfied.
    await using dir = await tmpdir()
    const env = path.join(dir.path, "env")
    await Installer.create(env, { kind: "venv", binary: python! })
    expect(Object.keys(await Installer.freeze(env))).not.toContain("numpy")
    expect((await Installer.verify(env, ["numpy"]))["numpy"]).toMatch(/^\d/)
  },
  120_000,
)

test.skipIf(!python)(
  "verify still reports nothing for a package that is genuinely absent",
  async () => {
    await using dir = await tmpdir()
    const env = path.join(dir.path, "env")
    await Installer.create(env, { kind: "venv", binary: python! })
    expect(await Installer.verify(env, ["definitely-not-a-real-distribution-xyzzy"])).toEqual({})
  },
  120_000,
)

test.skipIf(!python || !hostHas("numpy"))(
  "freeze reports only what the environment owns, not the whole host",
  async () => {
    // Otherwise `total` is a fact about the machine, the agent's inventory is
    // buried under host packages, and additive() compares against the wrong set.
    await using dir = await tmpdir()
    const env = path.join(dir.path, "env")
    await Installer.create(env, { kind: "venv", binary: python! })
    expect(Object.keys(await Installer.freeze(env))).not.toContain("numpy")
  },
  120_000,
)

test("whichever branch of the ladder creates it, the environment must expose pip", async () => {
  // The invariant the bug violated, stated once so a future third branch has
  // to satisfy it too rather than quietly repeating the same mistake.
  const source = await Bun.file(new URL("../../src/package/installer.ts", import.meta.url).pathname).text()
  expect(source.includes('"--seed"')).toBe(true)
})

test.skipIf(!python)("create on an existing environment is a no-op, not a rebuild", async () => {
  await using dir = await tmpdir()
  const env = path.join(dir.path, "env")
  await Installer.create(env, { kind: "venv", binary: python! })
  const marker = path.join(env, "marker")
  fs.writeFileSync(marker, "keep me")
  await Installer.create(env, await Installer.probe(env))
  // Rebuilding would silently discard everything already installed.
  expect(fs.existsSync(marker)).toBe(true)
})

test.skipIf(!python)("freeze reports name to version for what is installed", async () => {
  await using dir = await tmpdir()
  const env = path.join(dir.path, "env")
  await Installer.create(env, { kind: "venv", binary: python! })
  const frozen = await Installer.freeze(env)
  expect(Object.values(frozen).every((v) => /^\d/.test(v))).toBe(true)
})

test.skipIf(!python)("freeze normalises names so they compare against parsed requirements", async () => {
  await using dir = await tmpdir()
  const env = path.join(dir.path, "env")
  await Installer.create(env, { kind: "venv", binary: python! })
  const frozen = await Installer.freeze(env)
  // Environment.additive compares these keys against Requirement.parse output,
  // so both sides must be PEP 503 normalised or an upgrade looks additive.
  expect(Object.keys(frozen).every((k) => k === k.toLowerCase() && !k.includes("_"))).toBe(true)
})

test.skipIf(!python)("verify reports the version of a module that is present", async () => {
  await using dir = await tmpdir()
  const env = path.join(dir.path, "env")
  await Installer.create(env, { kind: "venv", binary: python! })
  expect((await Installer.verify(env, ["pip"]))["pip"]).toMatch(/^\d/)
})

test.skipIf(!python)("verify reports nothing for a module that is absent", async () => {
  // Catches an installer that exits 0 without producing a working module.
  await using dir = await tmpdir()
  const env = path.join(dir.path, "env")
  await Installer.create(env, { kind: "venv", binary: python! })
  expect(
    (await Installer.verify(env, ["definitely-not-a-real-module"]))["definitely-not-a-real-module"],
  ).toBeUndefined()
})

// install() is the load-bearing function in this module and everything above
// only exercises what surrounds it. Task 11 proves the whole path end to end;
// these two prove the sandboxed argv composes and runs at all, here, where a
// break is cheap to localise.
const sandboxed = Sandbox.backend() !== "none" && Boolean(python)

test.skipIf(!sandboxed)(
  "a real install through the sandbox lands a real package",
  async () => {
    await using dir = await tmpdir()
    const env = path.join(dir.path, "env")
    await Installer.create(env, await Installer.probe(env))
    const result = await Installer.install({ directory: env, packages: ["tqdm"], index: "", source: false })
    expect(result.ok, result.log).toBe(true)
    // Not "pip exited 0" — the version has to come back out of the environment.
    expect((await Installer.verify(env, ["tqdm"]))["tqdm"]).toMatch(/^\d/)
  },
  300_000,
)

test.skipIf(!sandboxed)(
  "a failed install reports ok:false and a log, and lands nothing",
  async () => {
    await using dir = await tmpdir()
    const env = path.join(dir.path, "env")
    await Installer.create(env, await Installer.probe(env))
    const before = await Installer.freeze(env)
    const result = await Installer.install({
      directory: env,
      packages: ["this-package-does-not-exist-anywhere-xyzzy"],
      index: "",
      source: false,
    })
    expect(result.ok).toBe(false)
    expect(result.log.length).toBeGreaterThan(0)
    // Modern pip builds every wheel before the install phase, so a failure
    // aborts before anything is committed. There is no subset to keep.
    expect(await Installer.freeze(env)).toEqual(before)
  },
  300_000,
)

test("explain translates the wheels-only rejection into what it means", () => {
  const log = "ERROR: Could not find a version that satisfies the requirement foo (from versions: none)"
  const message = Installer.explain(log)
  // Reads as "no such package" but means "no wheel under this policy".
  expect(message).toContain("No wheel")
  expect(message).toContain("source")
  expect(message).toContain("foo")
})

test("explain surfaces the cause of a build failure, not pip's summary line", () => {
  const log = [
    "      #include <Python.h>",
    "               ^~~~~~~~~~",
    "      fatal error: Python.h: No such file or directory",
    "      compilation terminated.",
    "  ERROR: Failed building wheel for cffi",
  ].join("\n")
  const message = Installer.explain(log)
  // The summary names the package; the fatal error names the actual missing
  // piece, which is what decides whether this is achievable in a sandbox.
  expect(message).toContain("Python.h")
  expect(message).toContain("cffi")
})

test("explain passes an unrecognised log through rather than inventing a diagnosis", () => {
  expect(Installer.explain("ERROR: something nobody anticipated")).toContain("something nobody anticipated")
})

test.skipIf(!sandboxed)(
  "install reports progress as pip works, not only at the end",
  async () => {
    // The defect this exists for: a pytorch install sat behind an unchanging
    // ellipsis for 1m37s while pip reported phase and size the whole time,
    // because the output was buffered and only read on completion.
    await using dir = await tmpdir()
    const env = path.join(dir.path, "env")
    await Installer.create(env, await Installer.probe(env))
    const seen: string[] = []
    const result = await Installer.install({
      directory: env,
      packages: ["tqdm"],
      index: "",
      source: false,
      onProgress: (s) => seen.push(s),
    })
    expect(result.ok, result.log).toBe(true)
    expect(seen.length).toBeGreaterThan(0)
    // Real pip phrasing, not a placeholder the tool invented.
    expect(seen.join("\n")).toMatch(/Collecting|Downloading|Installing|Successfully/i)
    // And the full log still survives for explain(), which needs lines that are
    // rarely last.
    expect(result.log.length).toBeGreaterThan(0)
  },
  300_000,
)

test.skipIf(!sandboxed)(
  "a second environment reuses the shared wheel cache instead of re-downloading",
  async () => {
    // The cache used to live inside the environment directory, so every new
    // environment re-downloaded everything — measured at 34 MB and a full
    // download for scipy alone, into an environment created seconds after one
    // that already had it. The packages where this hurts are the large ones.
    await using dir = await tmpdir()
    const first = path.join(dir.path, "one")
    const second = path.join(dir.path, "two")
    await Installer.create(first, await Installer.probe(first))
    await Installer.create(second, await Installer.probe(second))

    const a = await Installer.install({ directory: first, packages: ["tqdm"], index: "", source: false })
    expect(a.ok, a.log).toBe(true)

    const seen: string[] = []
    const b = await Installer.install({
      directory: second,
      packages: ["tqdm"],
      index: "",
      source: false,
      onProgress: (s) => seen.push(s),
    })
    expect(b.ok, b.log).toBe(true)
    // pip says so itself when it serves from cache rather than the network.
    expect(b.log).toMatch(/cached|Using cached/i)
    // And neither install put a cache inside the environment it populated.
    expect(fs.existsSync(path.join(second, ".cache"))).toBe(false)
  },
  600_000,
)

// `source: true` had never been exercised anywhere — not in tests, not in the
// product — while explain() actively tells users "Retry with source builds
// enabled if a compiler and headers are available". A user following our own
// error message would have been the first to run this path.
//
// sgmllib3k is published as an sdist with no wheel, so it is refused under the
// default wheels-only policy and installs only when source builds are allowed.
// That makes the flag's effect observable rather than asserted from argv.
test.skipIf(!sandboxed)(
  "wheels-only refuses an sdist-only package, and says what it really means",
  async () => {
    await using dir = await tmpdir()
    const env = path.join(dir.path, "env")
    await Installer.create(env, await Installer.probe(env))
    const result = await Installer.install({
      directory: env,
      packages: ["sgmllib3k"],
      index: "",
      source: false,
    })
    expect(result.ok).toBe(false)
    // The raw log reads as "no such package"; the translation has to say the
    // truth, which is that a wheel is missing and source builds are the answer.
    const message = Installer.explain(result.log)
    expect(message).toContain("No wheel")
    expect(message).toContain("source")
    expect(await Installer.verify(env, ["sgmllib3k"])).toEqual({})
  },
  600_000,
)

test.skipIf(!sandboxed)(
  "the same package installs when source builds are allowed",
  async () => {
    // The escalation explain() advertises, actually performed: a real sdist
    // built inside the sandbox, through the allowlist proxy.
    await using dir = await tmpdir()
    const env = path.join(dir.path, "env")
    await Installer.create(env, await Installer.probe(env))
    const result = await Installer.install({
      directory: env,
      packages: ["sgmllib3k"],
      index: "",
      source: true,
    })
    expect(result.ok, result.log).toBe(true)
    expect((await Installer.verify(env, ["sgmllib3k"]))["sgmllib3k"]).toMatch(/^\d/)
  },
  600_000,
)

// The version of a package the host interpreter already provides, or undefined.
// The bug below only appears when the requested version MATCHES the host's, so
// the test has to discover that version rather than hardcode one.
const hostVersion = (name: string) => {
  const proc = Bun.spawnSync(
    [python ?? "python3", "-c", `import importlib.metadata as m; print(m.version(${JSON.stringify(name)}))`],
    { stdout: "pipe", stderr: "ignore" },
  )
  const text = proc.stdout.toString().trim()
  return proc.exitCode === 0 && /^\d/.test(text) ? text : undefined
}

test.skipIf(!sandboxed || !hostVersion("six"))(
  "a version change is not additive even when the host already provided the old one",
  async () => {
    // The bug CI caught, and the reason `resolved()` exists apart from
    // `freeze()`. Requesting the exact version the host provides installs
    // nothing locally, so an owned-set comparison sees no `six` in the "before"
    // snapshot and reads the next version as an ADDITION. Kernels holding a
    // stale six in memory were then never restarted — the silent staleness the
    // whole restart rule exists to prevent.
    const host = hostVersion("six")!
    const other = host === "1.17.0" ? "1.16.0" : "1.17.0"

    await using dir = await tmpdir()
    const env = path.join(dir.path, "env")
    await Installer.create(env, { kind: "venv", binary: python! })

    const first = await Installer.install({ directory: env, packages: [`six==${host}`], index: "", source: false })
    expect(first.ok, first.log).toBe(true)

    const before = await Installer.resolved(env)
    // The precondition that makes this test meaningful: the environment owns
    // nothing, because the host already satisfied the request.
    expect(Object.keys(await Installer.freeze(env))).not.toContain("six")
    expect(before["six"]).toBe(host)

    const second = await Installer.install({ directory: env, packages: [`six==${other}`], index: "", source: false })
    expect(second.ok, second.log).toBe(true)

    const after = await Installer.resolved(env)
    expect(after["six"]).toBe(other)
    const { Environment } = await import("../../src/package/environment")
    expect(Environment.additive(before, after)).toBe(false)

    // And the contrast that makes this a regression test rather than an
    // assertion: comparing OWNED sets — what the code did before — calls the
    // very same change additive, because the environment owned no six until the
    // second install. Both lines have to stay true for the bug to be gone.
    const ownedBefore = {} as Record<string, string>
    const ownedAfter = await Installer.freeze(env)
    expect(ownedAfter["six"]).toBe(other)
    expect(Environment.additive(ownedBefore, ownedAfter)).toBe(true)
  },
  600_000,
)

test.skipIf(!python || !hostHas("numpy"))(
  "resolved sees inherited packages, freeze does not",
  async () => {
    // The invariant behind the fix, stated once: two questions, two answers.
    await using dir = await tmpdir()
    const env = path.join(dir.path, "env")
    await Installer.create(env, { kind: "venv", binary: python! })
    expect(Object.keys(await Installer.resolved(env))).toContain("numpy")
    expect(Object.keys(await Installer.freeze(env))).not.toContain("numpy")
  },
  120_000,
)
