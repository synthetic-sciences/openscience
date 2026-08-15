import { expect, test } from "bun:test"
import path from "path"
import { Installer } from "../../src/package/installer"

/**
 * Interpreter selection, and the Windows failure that produced these tests.
 *
 * Measured on a real machine: `python -m venv` exited 0, `ensurepip` genuinely
 * ran, and the environment came out at `<env>/lib/python3.9/site-packages` with
 * `<env>/bin/python.exe` — while every path in `installer.ts` looks under
 * `Scripts\`. `pyvenv.cfg` named the cause outright:
 *
 *     home = C:\msys64\mingw64\bin
 *     version = 3.9.7
 *
 * MSYS2's MinGW Python is a native Windows build that patches `sysconfig` to
 * the POSIX scheme. It was selected because PATH had no `python3.exe` before
 * `C:\msys64\mingw64\bin` — `C:\Python312` ships `python.exe` only — so the
 * `python3 ?? python` preference walked straight past a valid 3.12.
 */

const report = (over: Partial<Installer.Report> = {}): Installer.Report => ({
  exe: "C:\\Python312\\python.exe",
  version: [3, 12],
  platform: "win-amd64",
  purelib: "C:\\Python312\\Lib\\site-packages",
  prefix: "C:\\Python312",
  ...over,
})

const win = process.platform === "win32"

test.if(win)("a real python.org interpreter is accepted", () => {
  expect(Installer.reject(report())).toBeUndefined()
})

test.if(win)("the MSYS2 interpreter that caused this is rejected", () => {
  const why = Installer.reject(
    report({
      exe: "C:\\msys64\\mingw64\\bin\\python3.exe",
      version: [3, 9],
      platform: "mingw_x86_64",
      purelib: "C:\\msys64\\mingw64\\lib\\python3.9\\site-packages",
      prefix: "C:\\msys64\\mingw64",
    }),
  )
  expect(why).toContain("MSYS2")
})

test.if(win)("a POSIX layout is rejected on the scheme alone, whatever the vendor", () => {
  // The vendor check is a nicety for the error message; this is the property
  // that actually breaks the module, so it must stand on its own — otherwise
  // the next cross-built distribution walks through under a different name.
  const why = Installer.reject(report({ purelib: "C:\\Weird\\lib\\python3.12\\site-packages" }))
  expect(why).toContain("POSIX layout")
})

test.if(win)("a non-native platform tag is rejected", () => {
  expect(Installer.reject(report({ platform: "cygwin_x86_64" }))).toContain("not a native win-* build")
})

test.if(!win)("nothing is rejected off Windows, where the POSIX layout is correct", () => {
  expect(
    Installer.reject(report({ platform: "linux-x86_64", purelib: "/usr/lib/python3.12/site-packages" })),
  ).toBeUndefined()
})

test("select() prefers python over python3 on Windows, and the reverse elsewhere", async () => {
  // The single line that chose MSYS2. python.org ships `python.exe` and NO
  // `python3.exe`, so on Windows `python3` resolves to the Store alias or to a
  // POSIX-flavoured distribution nearly by definition. This asserts the source,
  // because the ordering cannot be observed from outside on a Linux CI box.
  const source = await Bun.file(new URL("../../src/package/installer.ts", import.meta.url).pathname).text()
  const body = source.slice(source.indexOf("export async function select()"))
  const order = body.slice(body.indexOf("const names"), body.indexOf("\n", body.indexOf("const names")))
  expect(order.indexOf('"python.exe"')).toBeLessThan(order.indexOf('"python3.exe"'))
  expect(order.indexOf('"python3"')).toBeLessThan(order.indexOf('"python"', order.indexOf('"python3"') + 1))
})

test("select() finds a working interpreter on this machine", async () => {
  const chosen = await Installer.select()
  expect(chosen.binary).toBeTruthy()
  expect(chosen.report?.prefix).toBeTruthy()
})

test("inspect() reports the real interpreter, and undefined for a non-interpreter", async () => {
  const chosen = await Installer.select()
  const found = await Installer.inspect(chosen.binary!)
  expect(found?.version[0]).toBe(3)
  // Debian and Ubuntu use dist-packages, not site-packages, for the system
  // interpreter — the assertion is that a package directory was reported.
  expect(found?.purelib).toMatch(/(site|dist)-packages/)
  // A Store alias exits non-zero; stand in for it with something that exists
  // and is not an interpreter, which is the same observable.
  expect(await Installer.inspect(process.execPath).catch(() => undefined)).toBeUndefined()
})

test("a rejected candidate does not end the search", async () => {
  // `Bun.which` answers once, so the old code stopped at the first hit. Both
  // Windows failures had a bad candidate ahead of a good one — the alias, then
  // MSYS2 — so "reject" has to mean "keep looking" across every PATH entry.
  const source = await Bun.file(new URL("../../src/package/installer.ts", import.meta.url).pathname).text()
  const body = source.slice(
    source.indexOf("export async function select()"),
    source.indexOf("async function registered"),
  )
  expect(body).toContain("continue")
  expect(body).not.toContain("Bun.which")
  // Every rejection is recorded, so the failure can say what it looked at.
  expect(body).toContain("rejected.push")
})

test("locate() searches both layouts, not just this platform's", async () => {
  const source = await Bun.file(new URL("../../src/package/installer.ts", import.meta.url).pathname).text()
  const body = source.slice(source.indexOf("export async function locate"))
  expect(body).toContain('"Scripts", "bin"')
})

test("the error no longer asserts a cause it did not measure", async () => {
  // The claim that a Windows failure "usually means" a Store alias was false on
  // the machine that hit it next, and reading as a finding rather than a guess
  // it sent the investigation to the Settings app for a full cycle.
  const source = await Bun.file(new URL("../../src/package/installer.ts", import.meta.url).pathname).text()
  const create = source.slice(source.indexOf("export async function create"), source.indexOf("const same ="))
  expect(create).not.toContain("App execution aliases")
  expect(create).not.toContain("usually means")
  // What replaced it: the interpreter used, what it reports, where one was
  // actually found, and what landed on disk.
  for (const fact of ["created with:", "an interpreter was found instead at:", "the tree contains:"])
    expect(create).toContain(fact)
})

test("a half-built environment is cleared rather than retried into", async () => {
  // `venv` and `uv` both short-circuit on an existing directory and report
  // success without replacing what is missing, so the first bad creation
  // repeats forever. Observed: "Requirement already satisfied" for pip and
  // setuptools on every retry, and the identical failure after it.
  const source = await Bun.file(new URL("../../src/package/installer.ts", import.meta.url).pathname).text()
  const create = source.slice(source.indexOf("export async function create"), source.indexOf("const same ="))
  const clear = create.indexOf("fs.rm(directory")
  expect(clear).toBeGreaterThan(-1)
  // Before the spawn, or the short-circuit still happens.
  expect(clear).toBeLessThan(create.indexOf("Bun.spawn"))
})

test("interpreter() and locate() agree for an environment built here", async () => {
  // The end-to-end property the Windows machine violated: what the module
  // requires and what creation produces must be the same file.
  const dir = path.join(
    process.env["TMPDIR"] ?? "/tmp",
    `openscience-interp-${process.pid}-${process.hrtime.bigint().toString(36)}`,
  )
  const tool = await Installer.probe(dir)
  await Installer.create(dir, tool)
  try {
    expect(await Installer.locate(dir)).toBe(Installer.interpreter(dir))
    // And it is genuinely rooted in the environment, not the host.
    const check = await Installer.inspect(Installer.interpreter(dir))
    expect(check?.prefix).toBeTruthy()
    // realpath, not just resolve — the same firmlink that broke `same()` in the
    // installer breaks the assertion about it. macOS temp is /var/folders/...,
    // /var is a symlink to /private/var, and Python reports the real path.
    const { realpathSync } = await import("fs")
    expect(realpathSync(check!.prefix)).toBe(realpathSync(dir))
  } finally {
    await (await import("fs/promises")).rm(dir, { recursive: true, force: true }).catch(() => {})
  }
}, 180_000)

test("the installer states what must be readable, never which backend needs telling", async () => {
  // The seam that keeps package installation platform-agnostic. `Installer`
  // knows a venv delegates to the interpreter named in pyvenv.cfg; it must not
  // know that an AppContainer needs an explicit ACL while bubblewrap does not.
  //
  // It briefly did: baseReadable() returned [] unless win32, added as a quick
  // fix when passing the base as readable made bwrap try to create a mountpoint
  // under a read-only root. That put backend knowledge in the caller. The filter
  // now lives in buildPolicy, where the backend is already known.
  const installer = await Bun.file(new URL("../../src/package/installer.ts", import.meta.url).pathname).text()
  const confined = installer.slice(installer.indexOf("async function confined"), installer.indexOf("progressLine"))
  expect(confined).toContain("readable")
  expect(confined).not.toContain("win32")
  expect(installer).not.toContain("baseReadable")

  // And the backend still decides what "readable" costs it. The bubblewrap
  // branch used to re-bind those paths itself, filtered to /tmp; main's model
  // binds every readable root explicitly and before the unreadable masks, so
  // re-binding them afterwards re-exposed masked files. The seam is unchanged —
  // the installer names paths, the backend decides — only the branch that does
  // the deciding moved.
  const sandbox = await Bun.file(new URL("../../src/sandbox/sandbox.ts", import.meta.url).pathname).text()
  const build = sandbox.slice(
    sandbox.indexOf("function buildPolicy"),
    sandbox.indexOf("export function seatbeltProfile"),
  )
  expect(build).toContain("input.readable")
  expect(build).toContain('input.backend === "appcontainer"')
})

test("base() still reports the interpreter a venv delegates to", async () => {
  const dir = path.join(
    process.env["TMPDIR"] ?? "/tmp",
    `openscience-base-${process.pid}-${process.hrtime.bigint().toString(36)}`,
  )
  const tool = await Installer.probe(dir)
  await Installer.create(dir, tool)
  try {
    // venv writes `home` on every platform, so this is answerable everywhere and
    // needs no platform branch to ask.
    expect(await Installer.base(dir)).toBeTruthy()
  } finally {
    await (await import("fs/promises")).rm(dir, { recursive: true, force: true }).catch(() => {})
  }
}, 180_000)

test("an interpreter the sandbox cannot be granted is a last resort, not a first choice", async () => {
  // Measured on a real machine: icacls on C:\Python312 was DENIED, then the
  // venv redirector said `No Python at '...'` and the child exited 103. The
  // interpreter was perfectly healthy; it was simply owned by SYSTEM, and
  // icacls can only change an ACL the caller owns. So a machine-wide Python is
  // unusable for a SANDBOXED run however good it is, and picking it produces a
  // failure several layers from the choice.
  const source = await Bun.file(new URL("../../src/package/installer.ts", import.meta.url).pathname).text()
  const body = source.slice(source.indexOf("export async function select()"))
  expect(body).toContain("ungrantable.push(candidate)")

  // Not refused outright, though: an UNSANDBOXED run works fine with a
  // machine-wide Python, and failing closed here would break everyone who never
  // turns the sandbox on. It falls back, and says why the sandbox will object.
  expect(body).toContain("so the sandbox cannot be granted read access to it")

  // Off Windows this whole question does not arise — bubblewrap and seatbelt
  // need no ACL to read anything.
  expect(Installer.grantable("/usr/bin/python3")).toBe(process.platform !== "win32")
})

test("the launcher refuses to continue when a read grant fails", async () => {
  // A failed READ grant is fatal where a failed write grant is not: it exists
  // only because something in there must be readable. Continuing produced a
  // child that could not start and an error nobody could trace back.
  const source = await Bun.file(new URL("../../src/sandbox/appcontainer.ts", import.meta.url).pathname).text()
  const main = source.slice(source.indexOf("export async function main"))
  expect(main).toContain("unreachable.length")
  // The remedy, not just the diagnosis.
  expect(main).toContain("install it for your user")
  expect(main).toContain("uv")
})

test("the Windows prerequisite is one check, read by every surface", async () => {
  // The user cannot discover this from anything else: an AppContainer can only
  // be granted access to paths its user OWNS, so a machine-wide Python is
  // unusable by a sandboxed process however healthy it is. Without a check, the
  // only symptom is an install failing much later with an error about the
  // interpreter rather than about ownership — which is exactly what happened,
  // and the agent then advised asking an admin for a permission that cannot be
  // granted.
  //
  // One source of truth, three surfaces. `describe()` and `selfTest()` once
  // disagreed about whether a backend existed because each answered separately;
  // a prerequisite with three implementations would drift the same way.
  const installer = await Bun.file(new URL("../../src/package/installer.ts", import.meta.url).pathname).text()
  expect(installer).toContain("export async function blocked()")

  const status = await Bun.file(new URL("../../src/cli/cmd/sandbox.ts", import.meta.url).pathname).text()
  expect(status).toContain("Installer.blocked()")
  const route = await Bun.file(new URL("../../src/server/routes/settings/sandbox.ts", import.meta.url).pathname).text()
  expect(route).toContain("Installer.blocked()")

  // Not on the hot path. Answering it runs candidate interpreters, which every
  // sandboxed command must not pay for.
  const sandbox = await Bun.file(new URL("../../src/sandbox/sandbox.ts", import.meta.url).pathname).text()
  expect(sandbox).not.toContain("Installer.blocked")
})

test("the prerequisite never claims containment is broken", async () => {
  // Containment is unaffected by this: shell commands stay confined, writes stay
  // blocked, egress stays bounded. Only Python environments are unavailable. A
  // user who reads "the sandbox does not work" and turns it off would lose
  // confinement they still had — a worse outcome than the problem.
  const installer = await Bun.file(new URL("../../src/package/installer.ts", import.meta.url).pathname).text()
  const body = installer.slice(installer.indexOf("export async function blocked()"))
  const message = body.slice(0, body.indexOf("\n  }"))
  expect(message).toContain("Python environments are unavailable")
  expect(message).toContain("Containment is unaffected")
  // And it names the fix, with the command, on both routes out.
  expect(message).toContain("winget install --id=astral-sh.uv")
  expect(message).toContain("'Install for all users' left OFF")
})

test("blocked() answers only where the question applies", async () => {
  // Off Windows there is no ACL to grant, so this must never fire — a POSIX
  // machine with a system Python is entirely fine.
  if (process.platform === "win32") return
  expect(await Installer.blocked()).toBeUndefined()
})

test("the prerequisite is checked where users actually meet it", async () => {
  // Nobody runs `sandbox status` voluntarily. A user meets this in one of two
  // places: the settings panel, or the moment the agent tries to install
  // something. Both now carry it.
  //
  // In package_install it runs BEFORE the approval card, because no amount of
  // approving an install fixes an interpreter the sandbox cannot reach — and
  // asking first would be a prompt whose only possible outcome is an error, the
  // same defect the bash-tool refusal already had to fix.
  const tool = await Bun.file(new URL("../../src/tool/package.ts", import.meta.url).pathname).text()
  const execute = tool.slice(tool.indexOf("async execute(params, ctx)"))
  expect(execute).toContain("Installer.blocked()")
  expect(execute.indexOf("Installer.blocked()")).toBeLessThan(execute.indexOf("ctx.ask("))

  const panel = await Bun.file(
    new URL("../../../../frontend/workspace/src/components/settings/Sandbox.tsx", import.meta.url).pathname,
  ).text()
  expect(panel).toContain("data()?.blocked")
  // Above the first policy control: a green backend sitting next to "installs
  // will fail" reads as a contradiction, and this is the line the user has to
  // act on before any of the switches below it matter. Anchored on the
  // "Protection" section rather than a specific box, because the panel's own
  // headings are main's and may be renamed without changing this property.
  expect(panel.indexOf("data()?.blocked")).toBeLessThan(panel.indexOf('title="Protection"'))
})

test("an environment pinned to an ungrantable base is rebuilt, not reused forever", async () => {
  // The failure that survived installing uv AND a user-owned Python. probe()
  // returns "existing" the moment Scripts/python.exe is there, so it never
  // re-selects — and an environment records its base in pyvenv.cfg at creation.
  // One built when the only candidate was C:\Python312 stays bound to it, so
  // every retry granted that path and was denied, no matter what interpreters
  // appeared afterwards.
  //
  // Measured: after `uv python install 3.12` the error was still "could not
  // grant sandbox access to C:\Python312" — the path in the existing pyvenv.cfg,
  // not one selection would choose now.
  const source = await Bun.file(new URL("../../src/package/installer.ts", import.meta.url).pathname).text()
  const probe = source.slice(
    source.indexOf("export async function probe"),
    source.indexOf("export async function create"),
  )
  expect(probe).toContain("const home = await base(directory)")
  expect(probe).toContain("grantable(home)")
  // Falling through is the rebuild: create() clears a directory that already has
  // a pyvenv.cfg, so the next tool builds fresh on a base that works.
  expect(probe).toContain("Sandbox.available()")
})

test("uv being installed is not treated as proof of a usable interpreter", async () => {
  // The false all-clear. `uv venv` builds from whatever uv DISCOVERS, which on a
  // machine with a system Python first is the same ungrantable one — so uv's
  // mere presence said "fine" while nothing had improved, and the user was told
  // to install uv, did, and hit the identical error.
  const source = await Bun.file(new URL("../../src/package/installer.ts", import.meta.url).pathname).text()
  const body = source.slice(source.indexOf("export async function blocked()"))
  expect(body).toContain("await managed()")
  // And the same answer PINS the rebuild, or a rebuild triggered because the old
  // base was ungrantable would let uv pick that same base again.
  const create = source.slice(source.indexOf("export async function create"))
  expect(create).toContain('"--python", pinned')
  // And only on Windows: grantability is a Windows question, so pinning
  // elsewhere would override uv's own choice for no reason.
  expect(create).toContain('process.platform === "win32" && tool.kind === "uv"')
  const helper = source.slice(source.indexOf("export async function managed()"))
  // It asks uv what it HAS, and requires one we could actually be granted.
  expect(helper).toContain('"--output-format", "json"')
  expect(helper).toContain("grantable(candidate)")
  // Only what uv MANAGES. `uv python list` also reports discovered system
  // interpreters and uv's own trampolines, and both are traps: the system one is
  // the ungrantable case this exists to route around, and pinning --python to a
  // trampoline gives "uv trampoline failed to spawn Python child process".
  expect(helper).toContain('"python", "dir"')
  expect(helper).toContain("under(absolute(root), candidate)")
})

test("uv paths are resolved against HOME, not the cwd", async () => {
  // Measured on Windows, uv 0.12.4, from `--output-format json` -- so the
  // shortening is not display-only, which is what the previous fix assumed:
  //
  //   "path":"AppData\\Roaming\\uv\\python\\cpython-3.12.13-...\\python.exe"
  //   "path":"C:\\Python312\\python.exe"
  //
  // Absolute and home-relative in the same array. Resolving the relative ones
  // against the cwd made grantable() pass on a path that does not exist;
  // rejecting them outright then hid every uv interpreter on the machine and
  // told a user with working uv to install uv.
  const source = await Bun.file(new URL("../../src/package/installer.ts", import.meta.url).pathname).text()
  const helper = source.slice(source.indexOf("const absolute ="), source.indexOf("const under ="))
  expect(helper).toContain("os.homedir()")
  expect(helper).not.toContain("process.cwd")
})

test("managed() returns an interpreter that exists, if uv has one here", async () => {
  // The property the source assertions cannot reach: whatever comes back must be
  // a real file. Both bugs so far returned a plausible path to nothing.
  const found = await Installer.managed()
  if (!found) return
  expect(path.isAbsolute(found)).toBe(true)
  expect(await Bun.file(found).exists()).toBe(true)
})

test("a working environment is not refused over a machine-wide prerequisite", async () => {
  // blocked() is a statement about a MACHINE. An environment that already exists
  // on a grantable base is a counterexample to it, and refusing an install into
  // one -- while telling the user to set up the tool that built it -- is how the
  // uv parsing bug surfaced.
  const source = await Bun.file(new URL("../../src/tool/package.ts", import.meta.url).pathname).text()
  const body = source.slice(source.indexOf("async execute("))
  expect(body).toContain("if (!usable) {")
  expect(body.indexOf('tool.kind === "existing"')).toBeLessThan(body.indexOf("Installer.blocked()"))
})
