import { afterAll, beforeAll, expect, test } from "bun:test"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { Config } from "../../src/config/config"
import { Installer } from "../../src/package/installer"
import { EgressRuntime } from "../../src/sandbox/egress-runtime"
import { Sandbox } from "../../src/sandbox/sandbox"

/**
 * `package_install` end to end, on a real Windows kernel.
 *
 * This exists because the loop was wrong, not because a particular bug was
 * hard. The chain a Windows install goes through is:
 *
 *   select interpreter -> create venv -> pin base -> grant base ACL ->
 *   launcher spawns base -> pip runs -> shim -> broker -> network
 *
 * `appcontainer-live` covers containment and `appcontainer-transport` covers the
 * pipe. NOTHING covered the seven hops between them, so each one was found by a
 * human rebooting into Windows, running one command, and pasting the error —
 * five rounds, each fix shipping a fresh unverified assumption that became the
 * next round's failure. Two of them were assumptions about uv's output format
 * that were checked on Linux, where they happen to be true.
 *
 * So the assertions below are deliberately staged rather than one big "it
 * installed": a red run has to say WHICH hop broke, because the machine is not
 * one anybody can log into.
 *
 *   1. "uv provisions a base under the user profile" — the prerequisite. Red
 *      here means the CI setup step did not install uv or a managed Python, and
 *      nothing after it means anything.
 *   2. "an environment is created on a grantable base" — `create()` and the
 *      `--python` pin. Red means uv chose a base we cannot grant.
 *   3. "the environment's launcher can spawn its base inside the container" —
 *      the hop that produced `uv trampoline failed to spawn Python child
 *      process: permission denied (os error 5)`. A venv is not a Python; on
 *      Windows `Scripts\python.exe` is a stub that spawns the real interpreter
 *      elsewhere, and an AppContainer reaches nothing whose ACL does not name
 *      its SID. Red means we granted a path that is not the one the stub uses.
 *   4. "pip installs a package through the broker" — the merge gate itself, and
 *      the first thing that has ever moved a byte over the named pipe.
 */

const windows = process.platform === "win32"

// Stated, not inherited. `Config.trustedSandbox()` defaults to disabled/deny, so
// a test that reads the ambient policy runs UNSANDBOXED and passes while proving
// nothing — which is exactly what happened: "Successfully installed six-1.17.0"
// with `egress: <none>`, on a job whose entire purpose is the sandboxed path.
beforeAll(async () => {
  const { Config } = await import("../../src/config/config")
  await Config.setSandbox({ enabled: true, network: "allowlist" })
})

afterAll(async () => {
  const { Global } = await import("../../src/global")
  const { Config } = await import("../../src/config/config")
  const fsp = await import("fs/promises")
  for (const name of ["openscience.jsonc", "openscience.json", "config.json"]) {
    await fsp.rm(path.join(Global.Path.config, name), { force: true }).catch(() => {})
  }
  Config.global.reset()
})

/** Kept across the staged tests: each one builds on the last, and rebuilding an
 *  environment per test would triple an already slow job. */
let workspace: string | undefined
let environment: string | undefined

const scratch = async () => {
  if (workspace) return workspace
  workspace = await fs.mkdtemp(path.join(os.tmpdir(), "openscience-install-"))
  environment = path.join(workspace, "env")
  return workspace
}

test.if(windows)(
  "uv provisions a base interpreter under the user profile",
  async () => {
    const found = await Installer.managed()
    console.log(`  managed interpreter: ${found ?? "<none>"}`)
    // Not a soft skip. If CI has no managed Python the remaining tests would
    // pass vacuously against a system interpreter, which is exactly the
    // configuration that cannot work and exactly what we are here to catch.
    expect(found).toBeTruthy()
    expect(Installer.grantable(found!)).toBe(true)
    expect(await Bun.file(found!).exists()).toBe(true)
  },
  120_000,
)

test.if(windows)(
  "an environment is created on a base the sandbox can be granted",
  async () => {
    await scratch()
    const tool = await Installer.probe(environment!)
    console.log(`  tool: ${tool.kind} (${tool.binary})`)
    await Installer.create(environment!, tool)
    const home = await Installer.base(environment!)
    console.log(`  pyvenv.cfg home: ${home}`)
    expect(home).toBeTruthy()
    expect(Installer.grantable(home!)).toBe(true)
  },
  300_000,
)

test.if(windows)(
  "the granted base interpreter itself runs inside the container",
  async () => {
    // The discriminator. The first CI run reproduced `uv trampoline failed to
    // spawn Python child process` and, in the same log, showed that the path we
    // grant and the path `sys._base_executable` names are the SAME directory —
    // so the leading theory (we grant the wrong hop) was wrong.
    //
    // That leaves two possibilities the failing test cannot tell apart: the
    // grant is not taking effect at all, or it is and something about the
    // trampoline's own spawn is refused. Running the base directly, with the
    // identical grant and no venv in the picture, separates them. Green here
    // plus red below means the grant works and the trampoline is the problem;
    // red here means nothing downstream was ever going to work.
    const home = await Installer.base(environment!)
    expect(home).toBeTruthy()
    // Printed unconditionally, because it is the difference between "the ACE
    // did not land" and "it landed on a link". uv keeps a patch-versioned
    // directory and a stable name beside it; `pyvenv.cfg` points at the stable
    // one, and an ACE on a reparse point is not an ACE on its target.
    const real = await fs.realpath(home!).catch(() => "<unresolvable>")
    console.log(`  pyvenv home  : ${home}`)
    console.log(`  resolves to  : ${real}${real === home ? "  (not a link)" : "  (LINK)"}`)
    const spec = await Sandbox.wrapArgv({
      file: path.join(home!, "python.exe"),
      args: ["-c", "import sys; print(sys.version_info[:2])"],
      workspace: [environment!],
      readable: [home!],
      options: { enabled: true, network: "deny", onUnavailable: "error", allowWrite: [] },
    })
    const proc = Bun.spawn([spec.file, ...(spec.args ?? [])], {
      env: { ...process.env, ...spec.env },
      stdout: "pipe",
      stderr: "pipe",
    })
    const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()])
    await proc.exited
    console.log(`  exit ${proc.exitCode}\n  stdout: ${out.trim()}\n  stderr: ${err.trim()}`)
    expect(proc.exitCode).toBe(0)
  },
  180_000,
)

test.if(windows)(
  "the environment's launcher can spawn its base inside the container",
  async () => {
    const home = await Installer.base(environment!)
    const binary = Installer.interpreter(environment!)

    // Unsandboxed first, and printed. `sys._base_executable` is the binary the
    // launcher actually exec'd — if the sandboxed run below fails, this line
    // and `home` above are the whole diagnosis, because a mismatch between them
    // IS the bug. Getting that comparison out of CI logs rather than out of a
    // human's PowerShell window is most of the point of this file.
    const code =
      "import sys; print(sys.executable); print(getattr(sys,'_base_executable',None)); print(sys.base_prefix)"
    const host = Bun.spawn([binary, "-c", code], { stdout: "pipe", stderr: "pipe" })
    const chain = await new Response(host.stdout).text()
    await host.exited
    console.log(`  granted home     : ${home}`)
    for (const line of chain.trim().split("\n")) console.log(`  resolves through : ${line.trim()}`)

    const spec = await Sandbox.wrapArgv({
      file: binary,
      args: ["-c", "import sys; print(sys.version_info[:2])"],
      workspace: [environment!],
      ...(home ? { readable: [home] } : {}),
      // No network: this isolates the spawn from everything the broker does.
      options: { enabled: true, network: "deny", onUnavailable: "error", allowWrite: [] },
    })
    const proc = Bun.spawn([spec.file, ...(spec.args ?? [])], {
      env: { ...process.env, ...spec.env },
      stdout: "pipe",
      stderr: "pipe",
    })
    const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()])
    await proc.exited
    console.log(`  exit ${proc.exitCode}\n  stdout: ${out.trim()}\n  stderr: ${err.trim()}`)
    expect(proc.exitCode).toBe(0)
    expect(out).toContain("(3,")
  },
  180_000,
)

test.if(windows)(
  "bun itself runs inside the container",
  async () => {
    // The shim is `bun <bundle>` in a source checkout, and it dies with
    // `error loading current directory` even when lpCurrentDirectory names a
    // directory the container holds (F) on and which is Low-labelled. So the
    // question is no longer "which directory" but whether bun can run in an
    // AppContainer at all.
    //
    // It matters beyond this test. If bun cannot, the dev shim path is not
    // testable this way and the broker has to be exercised through a compiled
    // binary — which is the code that ships, so that is the better test anyway
    // and only the CI plumbing changes. If bun CAN, the fault is in the shim
    // bundle or its arguments and stays where it is.
    const spec = await Sandbox.wrapArgv({
      file: process.execPath,
      args: ["--version"],
      workspace: [environment!],
      readable: [process.execPath],
      options: { enabled: true, network: "deny", onUnavailable: "error", allowWrite: [] },
    })
    const proc = Bun.spawn([spec.file, ...(spec.args ?? [])], {
      env: { ...process.env, ...spec.env },
      cwd: environment!,
      stdout: "pipe",
      stderr: "pipe",
    })
    const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()])
    await proc.exited
    console.log(`  bun exit ${proc.exitCode}\n  stdout: ${out.trim()}\n  stderr: ${err.trim()}`)
    expect(proc.exitCode).toBe(0)
  },
  180_000,
)

test.if(windows)(
  "a pre-existing subdirectory of the workspace is writable inside the container",
  async () => {
    // NOTE, corrected: this test now PASSES, and the conclusion drawn from its
    // earlier failure was wrong. The Low label does reach a pre-existing
    // subdirectory; what actually broke was an over-broad `readable` list
    // leaking main's derived read roots into the Windows GRANT list, which sent
    // icacls at every directory on PATH. The check is kept because it is cheap
    // and it pins a property the sandbox genuinely depends on.
    //
    // Original note, left for the reasoning it records:
    // TMPDIR pointed inside the granted environment and pip STILL could not
    // write there:
    //
    //     [Errno 13] Permission denied:
    //     '...\\openscience-install-K9UXyg\\env\\.tmp\\pip-unpack-...\\six-...whl.metadata'
    //
    // The self-test already proves a write in the workspace ROOT succeeds, and
    // `grant()` labels that root Low because Mandatory Integrity Control is
    // evaluated before the DACL and a Low process cannot write to a Medium
    // object whatever the DACL says. The open question is whether that label
    // reaches a subdirectory that already existed when the grant was applied —
    // `icacls /setintegritylevel (OI)(CI)L` sets inheritance on the target, and
    // inheritance is not the same as rewriting children.
    //
    // Both halves are measured here: a directory created BEFORE the launch and
    // one created after. If only the second is writable, propagation is the
    // fault and every pre-created scratch directory in the product has it.
    const before = path.join(environment!, "pre-existing")
    await fs.mkdir(before, { recursive: true })
    const code = [
      "import os, sys",
      `open(os.path.join(r"${before}", "x.txt"), "w").write("ok")`,
      `os.makedirs(os.path.join(r"${environment!}", "made-inside"), exist_ok=True)`,
      `open(os.path.join(r"${environment!}", "made-inside", "y.txt"), "w").write("ok")`,
      "print('both writes succeeded')",
    ].join("\n")
    const spec = await Sandbox.wrapArgv({
      file: Installer.interpreter(environment!),
      args: ["-c", code],
      workspace: [environment!],
      options: { enabled: true, network: "deny", onUnavailable: "error", allowWrite: [] },
    })
    const proc = Bun.spawn([spec.file, ...(spec.args ?? [])], {
      env: { ...process.env, ...spec.env },
      cwd: environment!,
      stdout: "pipe",
      stderr: "pipe",
    })
    const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()])
    await proc.exited
    console.log(`  exit ${proc.exitCode}\n  stdout: ${out.trim()}\n  stderr: ${err.trim()}`)
    expect(proc.exitCode).toBe(0)
  },
  180_000,
)

test.if(windows)(
  "pip reaches PyPI through the broker",
  async () => {
    // Spawned here rather than through `Installer.install` for one reason:
    // stdio. `install` buffers stderr and prints it only when the install
    // RETURNS, so the run that first got this far produced 600 seconds of
    // silence and not one line about why. Inheriting stderr streams the
    // launcher's debug into the CI log as it happens, which is the whole
    // reason this job exists.
    //
    // The abort is deliberate and short. A refused connection fails in seconds;
    // a hang means the shim accepted and the relay stalled, and those are
    // different bugs. Ten minutes of waiting distinguishes them no better than
    // three does.
    const policy = await Config.trustedSandbox()
    const egress = await EgressRuntime.egressFor(policy)
    console.log(`  egress: ${egress ?? "<none>"}`)
    expect(egress).toBeTruthy()
    const home = await Installer.base(environment!)
    const cache = path.join(workspace!, "pip-cache")
    // No TMPDIR of its own. `spec.env` carries the sandbox's per-spawn temp
    // root, which is granted and labelled as a ROOT; a directory pre-created
    // here would be a child of the workspace and is not what the product uses
    // any more. This test reconstructs `Installer.install`, and drifting from
    // it is precisely how the reconstruction stops proving anything.
    await fs.mkdir(cache, { recursive: true })
    const spec = await Sandbox.wrapArgv({
      file: Installer.interpreter(environment!),
      args: ["-m", "pip", "install", "--disable-pip-version-check", "--only-binary", ":all:", "six"],
      workspace: [environment!, cache],
      ...(home ? { readable: [home] } : {}),
      options: { ...policy, egress },
    })
    const proc = Bun.spawn([spec.file, ...(spec.args ?? [])], {
      env: { ...process.env, ...spec.env, PIP_CACHE_DIR: cache },
      cwd: environment!,
      stdout: "pipe",
      stderr: "inherit",
      signal: AbortSignal.timeout(180_000),
    })
    const out = await new Response(proc.stdout).text()
    await proc.exited
    for (const line of out.trim().split("\n")) console.log(`  pip: ${line}`)
    expect(proc.exitCode).toBe(0)
    const found = await Installer.verify(environment!, ["six"])
    console.log(`  verify: ${JSON.stringify(found)}`)
    expect(found["six"]).toBeTruthy()
  },
  240_000,
)

test.if(windows)(
  "Installer.install works, not just a hand-composed equivalent",
  async () => {
    // The test above spawns pip itself so stderr can stream. That is a
    // reconstruction of `install()`, and a reconstruction proves the transport
    // rather than the product -- the TMPDIR omission above is precisely the
    // class of difference that hides in one. So the real entry point runs too,
    // once, against a package the previous test already cached.
    const result = await Installer.install({
      directory: environment!,
      packages: ["six"],
      index: "",
      source: false,
      // Bounded so it RETURNS. install() buffers stderr and prints it only on
      // return, so a run that outlives the test timeout produces five minutes
      // of silence and not one line about why — which is exactly what the last
      // run did.
      signal: AbortSignal.timeout(150_000),
      onProgress: (status) => console.log(`  ${status}`),
    })
    if (!result.ok) console.log(result.log)
    expect(result.ok).toBe(true)
    const found = await Installer.verify(environment!, ["six"])
    console.log(`  verify: ${JSON.stringify(found)}`)
    expect(found["six"]).toBeTruthy()
  },
  300_000,
)

test.if(windows)("clean up", async () => {
  if (workspace) await fs.rm(workspace, { recursive: true, force: true }).catch(() => {})
})
