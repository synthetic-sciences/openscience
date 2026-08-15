import { expect, test } from "bun:test"
import { AppContainer } from "../../src/sandbox/appcontainer"
import { Sandbox } from "../../src/sandbox/sandbox"

/**
 * What can be tested without Windows.
 *
 * The Win32 calls cannot run here, and pretending otherwise would be worse than
 * admitting it — the probe already measured that sequence on a real machine.
 * What IS testable is everything around them: the spec round trip, the
 * UTF-16 encoding those `...W` entry points require, and the command-line
 * quoting, which is where a silent mistake would hide. `CommandLineToArgvW`
 * re-splits a single string with rules that are neither the shell's nor
 * POSIX's, so a path like `C:\Users\me\My Project\` can quietly change what the
 * child executes rather than failing loudly.
 */

test("the spec survives the base64 round trip Sandbox composes", () => {
  const policy = {
    writable: ["C:\\work\\project"],
    unreadable: ["C:\\Users\\me\\.ssh\\id_rsa"],
    network: "allowlist" as const,
    egress: "openscience-broker-abc",
    profile: "openscience-deadbeef",
  }
  const args = Sandbox.appContainerArgs(policy, ["python.exe", "-u", "k.py"])
  const spec = AppContainer.decode(args[1]!)
  expect(spec.profile).toBe("openscience-deadbeef")
  expect(spec.writable).toEqual(["C:\\work\\project"])
  expect(spec.unreadable).toEqual(["C:\\Users\\me\\.ssh\\id_rsa"])
  expect(spec.network).toBe("allowlist")
  expect(spec.pipe).toBe("openscience-broker-abc")
})

test("a spec with no profile is rejected rather than launched unconfined", () => {
  const blob = Buffer.from(JSON.stringify({ writable: [], unreadable: [], network: "deny" })).toString("base64")
  expect(() => AppContainer.decode(blob)).toThrow("profile")
})

test("wide() produces null-terminated UTF-16LE", () => {
  // Every ...W entry point reads until a null. A missing terminator reads past
  // the buffer; a UTF-8 buffer is silently misinterpreted as UTF-16 pairs.
  const buf = AppContainer.wide("Hi")
  expect([...buf]).toEqual([0x48, 0x00, 0x69, 0x00, 0x00, 0x00])
})

test("readWide reverses wide(), and stops at the terminator", () => {
  const sid = "S-1-15-2-3041870312-880516233"
  const buf = AppContainer.wide(sid)
  // Trailing garbage after the null must be ignored, the way a real SID buffer
  // returned by ConvertSidToStringSid sits inside a larger allocation.
  const padded = Buffer.concat([buf, Buffer.from([0x41, 0x00, 0x42, 0x00])])
  expect(AppContainer.readWide(new Uint8Array(padded))).toBe(sid)
})

test.each([
  ["plain", "python.exe", "python.exe"],
  ["a space", "My Project", '"My Project"'],
  ["a quote", 'say"hi', '"say\\"hi"'],
  // A trailing backslash before the closing quote must be doubled, or it
  // escapes the quote and swallows the next argument.
  ["a trailing backslash with a space", "C:\\My Dir\\", '"C:\\My Dir\\\\"'],
  ["backslashes before a quote", 'a\\\\"b', '"a\\\\\\\\\\"b"'],
  ["backslashes with no quote", "C:\\a\\b", "C:\\a\\b"],
])("quoting %s survives CommandLineToArgvW", (_label, input, expected) => {
  expect(AppContainer.quote(input)).toBe(expected)
})

test("a Windows path with spaces round-trips through the whole command line", () => {
  // The case that matters in practice: the interpreter of a managed environment
  // under a user profile whose name has a space in it.
  const argv = ["C:\\Users\\A B\\.cache\\openscience\\envs\\p\\default\\Scripts\\python.exe", "-u", "C:\\w\\k.py"]
  const line = AppContainer.commandLine(argv)
  expect(line).toContain('"C:\\Users\\A B\\')
  // Re-split the way CommandLineToArgvW would, to prove the quoting is not
  // merely plausible. This mirrors the documented algorithm.
  const parsed: string[] = []
  let current = ""
  let quoted = false
  let slashes = 0
  const flush = () => {
    if (current || quoted) parsed.push(current)
    current = ""
  }
  for (const ch of line) {
    if (ch === "\\") {
      slashes++
      continue
    }
    if (ch === '"') {
      current += "\\".repeat(Math.floor(slashes / 2))
      if (slashes % 2) current += '"'
      else quoted = !quoted
      slashes = 0
      continue
    }
    current += "\\".repeat(slashes)
    slashes = 0
    if (ch === " " && !quoted) {
      flush()
      continue
    }
    current += ch
  }
  current += "\\".repeat(slashes)
  flush()
  expect(parsed).toEqual(argv)
})

test("the launcher refuses to run anywhere but Windows", () => {
  // Guards against a Linux caller reaching FFI that would dlopen kernel32.
  if (process.platform === "win32") return
  expect(() => AppContainer.launch("S-1-15-2-1", ["x"])).toThrow("only runs on Windows")
})

test("the entry point is wired before anything else the process does", async () => {
  // This test used to check that the argv branch sat above `unhandledRejection`
  // in `src/index.ts`, which measured nothing: ESM evaluates every static
  // import before the first statement of the importing module, so "first in the
  // file" and "first in the process" are not the same claim. The imports above
  // it bootstrapped the user's directories, and the egress shim — this binary,
  // re-entered INSIDE the sandbox — died there before running any of its own
  // code. Position is now enforced by the module graph and asserted for real in
  // test/sandbox/fastpath.test.ts, which makes those directories unwritable.
  const source = await Bun.file(new URL("../../src/sandbox/fastpath.ts", import.meta.url).pathname).text()
  expect(source).toContain('process.argv[2] === "__appcontainer-launch"')
  // Nothing static: an import here is evaluated before the argv checks below it
  // and puts the whole problem back.
  expect(source.match(/^import .*/gm)).toBeNull()
})

test("the Windows grant list is exactly what the caller named", () => {
  // `readable` means two different things per backend. On POSIX it is "what may
  // be read", derived from runtime roots and the workspace, and binding those
  // into a namespace costs nothing. On Windows every entry gets an ACE written
  // to it with `icacls`, so inheriting the derived set made the launcher try to
  // rewrite the ACLs of every directory on PATH — C:\Windows and
  // C:\Windows\System32 among them. Unelevated that merely failed, slowly:
  // 117 seconds of icacls calls before a trivial `exit 7` gave up. Elevated it
  // would have SUCCEEDED, granting an AppContainer standing access to the
  // system directories.
  //
  // So: nothing the caller did not name, and empty stays empty.
  const spec = (wrapped: { args?: string[] }) => {
    const args = wrapped.args ?? []
    const at = args.indexOf("__appcontainer-launch")
    expect(at).toBeGreaterThan(-1)
    return AppContainer.decode(args[at + 1]!)
  }

  // POSIX-shaped paths even though the backend is win32: this runs on a Linux
  // runner, where `dedupe`'s path.resolve rewrites a `C:\...` string into a
  // cwd-relative one and the filters then drop it. The property under test is
  // how many entries survive, which does not depend on their spelling.
  const bare = Sandbox.wrapArgv({
    file: "cmd.exe",
    args: ["/c", "exit 7"],
    workspace: ["/work/project"],
    options: { enabled: true, network: "deny" },
    platform: "win32",
  })
  try {
    expect(spec(bare).readable ?? []).toEqual([])
  } finally {
    Sandbox.cleanup(bare)
  }

  const base = "/opt/uv/python/cpython-3.12"
  const named = Sandbox.wrapArgv({
    file: "python.exe",
    args: [],
    workspace: ["/work/project"],
    readable: [base],
    options: { enabled: true, network: "deny" },
    platform: "win32",
  })
  try {
    // Count and content, not the exact string: `dedupe` resolves paths, and a
    // Windows path resolved on a Linux test runner comes back rewritten. The
    // regression this guards against produced dozens of entries, so one is the
    // assertion that matters.
    const readable = spec(named).readable ?? []
    expect(readable).toHaveLength(1)
    expect(readable[0]).toContain("cpython-3.12")
  } finally {
    Sandbox.cleanup(named)
  }
})

test("describe() reports the appcontainer backend as available", () => {
  // Two commands reading the same backend() disagreed on a real Windows
  // machine: `sandbox status` printed "unavailable - no sandbox backend for
  // platform win32" while `sandbox test` printed "Sandbox self-test
  // (appcontainer)" and ran checks. describe() had a seatbelt/bubblewrap
  // whitelist, so widening the Backend type without widening it here made the
  // new backend fall through to the "none" branch.
  const source = Bun.file(new URL("../../src/sandbox/sandbox.ts", import.meta.url).pathname)
  return source.text().then((text) => {
    const body = text.slice(text.indexOf("export function describe()"), text.indexOf("writable-path assembly"))
    expect(body.includes('b === "appcontainer"')).toBe(true)
    expect(body.includes('tool: "AppContainer"')).toBe(true)
  })
})

test("the child inherits the launcher's std handles", async () => {
  // `bInheritHandles: false` with no STARTF_USESTDHANDLES was silently fatal:
  // the launcher runs with its stdout on a pipe, so a child inheriting nothing
  // had nowhere to write and EVERY sandboxed command came back empty. The first
  // Windows self-test read that empty stdout, found no package SID, and
  // reported the container as not applied — a launcher bug wearing a policy
  // bug's clothes. Not test-only: pip progress and every tool result cross here.
  const source = await Bun.file(new URL("../../src/sandbox/appcontainer.ts", import.meta.url).pathname).text()
  const body = source.slice(source.indexOf("export function launch"))
  // bInheritHandles is the last argument before the creation flags. Slicing to
  // the first ")" would land inside `ffi.ptr(line)`, so bound it on the flags.
  const create = body.slice(body.indexOf("kernel.CreateProcessW"), body.indexOf("EXTENDED_STARTUPINFO_PRESENT |"))
  expect(create).toContain("true,")
  expect(create).not.toContain("false,")
  expect(body).toContain("STARTF_USESTDHANDLES")
  // Handles we were given are not necessarily marked inheritable in us.
  expect(body).toContain("SetHandleInformation")
  // The flag must not be set without handles behind it, or the child gets no
  // stdout at all — the same failure by another route.
  expect(body.indexOf("if (stdout && stderr)")).toBeLessThan(body.indexOf("STARTF_USESTDHANDLES, true"))
})

test("the CreateProcess failure explains 203, the code a real machine returned", async () => {
  // The hint listed Win32 5 and 2. The machine returned 203, so at the moment of
  // failure the number carried no meaning at all. 203 is ERROR_ENVVAR_NOT_FOUND,
  // which points at the environment rather than the command — lpApplicationName
  // is null, so Windows resolves argv[0] itself and needs an environment to do
  // it in.
  const source = await Bun.file(new URL("../../src/sandbox/appcontainer.ts", import.meta.url).pathname).text()
  expect(source).toContain("203 is ERROR_ENVVAR_NOT_FOUND")
  // Comments are not code: this asserts the flag is not USED, and the comment
  // explaining why it was removed must not trip it.
  const code = source
    .split("\n")
    .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
    .join("\n")
  // And the flag that described an environment block we never supply is gone.
  expect(code).not.toContain("CREATE_UNICODE_ENVIRONMENT")
})

test("readable paths reach the launcher and are granted read+execute, not full control", async () => {
  // The gap that made Windows look like a broken machine. bubblewrap binds the
  // whole filesystem read-only and seatbelt allows reads unless denied, so
  // `readable` is a no-op on both and its absence here went unnoticed. An
  // AppContainer reaches nothing whose ACL does not name its package SID, so
  // dropping it left the kernel unable to read its own interpreter: `dir`
  // returned "Access is denied" and the venv redirector reported
  // `No Python at '...'` for a Python that was installed and working.
  const args = Sandbox.appContainerArgs(
    {
      writable: ["C:\\work\\project"],
      readable: ["C:\\Python312"],
      unreadable: [],
      network: "deny" as const,
      profile: "openscience-deadbeef",
    },
    ["python.exe"],
  )
  expect(AppContainer.decode(args[1]!).readable).toEqual(["C:\\Python312"])

  const source = await Bun.file(new URL("../../src/sandbox/appcontainer.ts", import.meta.url).pathname).text()
  // Bounded at the next function, not at quote(): revoke() sits between them and
  // legitimately sets the label back to Medium, which a wider slice misreads as
  // grant() relabelling the READ set.
  const body = source.slice(source.indexOf("export function grant"), source.indexOf("export function removeProfile"))
  // Read AND execute: the interpreter must be runnable, so plain (R) is not
  // enough. Never (F) for the read set — that would hand a sandboxed process
  // write access to the Python installation it is confined away from.
  expect(body).toContain("(OI)(CI)(RX)")
  expect(body).toContain("(OI)(CI)(F)")
  expect(body.indexOf("(OI)(CI)(F)")).toBeLessThan(body.indexOf("(OI)(CI)(RX)"))
})

test("a path that is already writable is not re-granted as read-only", () => {
  // Two ACEs for one SID on one path is not wrong, but the weaker one is noise
  // in `icacls` output and makes a real grant failure harder to spot.
  const args = Sandbox.appContainerArgs(
    {
      writable: ["C:\\work\\project"],
      readable: ["C:\\work\\project", "C:\\Python312"],
      unreadable: [],
      network: "deny" as const,
      profile: "p",
    },
    ["x.exe"],
  )
  const spec = AppContainer.decode(args[1]!)
  expect(spec.readable).toContain("C:\\work\\project")
  // The de-duplication is in grant(), which is where both lists are known.
  expect(Bun.file(new URL("../../src/sandbox/appcontainer.ts", import.meta.url).pathname).text()).resolves.toContain(
    "readable.filter((p) => !writable.includes(p))",
  )
})

test("the launcher can dump every value CreateProcess is given", async () => {
  // `sandbox test` proved the child runs unconfined: CreateProcess succeeds, the
  // command executes, and the token carries no package SID. The probe ran this
  // same sequence successfully in PowerShell on the same machine, so the fault
  // is in what we hand the kernel. Each guess at that cost a full rebuild cycle,
  // which is why the values are now dumpable in one run.
  const source = await Bun.file(new URL("../../src/sandbox/appcontainer.ts", import.meta.url).pathname).text()
  const body = source.slice(source.indexOf("export function launch"))
  expect(body).toContain("OPENSCIENCE_SANDBOX_DEBUG")
  // The four values that can each independently cause a silent no-op: the SID,
  // the struct handed to UpdateProcThreadAttribute, cb, and the list pointer.
  for (const value of ["capabilities ", "startupinfoex ", "cb=", "lpAttributeList=0x"]) expect(body).toContain(value)
})

test("the FFI bindings are opened once and held", async () => {
  // dlopen returns a library object that owns the handle; keeping only .symbols
  // left it garbage, and Bun closes a library when that object is collected —
  // unmapping code a later call jumps into. main() bound three times per launch
  // and launch() opened advapi32 a fourth.
  const source = await Bun.file(new URL("../../src/sandbox/appcontainer.ts", import.meta.url).pathname).text()
  expect(source).toContain("libs: [userenv, advapi, kernel]")
  expect(source).toContain("bound ??= open()")
  // advapi32 must not be reopened inside launch().
  const body = source.slice(source.indexOf("export function launch"))
  expect(body).not.toContain("dlopen")
})

test("cmd.exe gets its tail verbatim, not CommandLineToArgvW quoting", () => {
  // Measured on a real machine. cmd does NOT parse its /c tail with
  // CommandLineToArgvW and does not recognise a backslash-escaped quote, so
  // quoting the tail normally produced
  //   "echo hi>\"C:\\...\\probe\""
  // and cmd answered "The filename, directory name, or volume label syntax is
  // incorrect." The same shape turned `dir C:\` into `dir C:\\`.
  const command = 'echo hi>"C:\\Users\\naray\\AppData\\Local\\Temp\\openscience-sbx-ab12\\probe"'
  const line = AppContainer.commandLine(["C:\\WINDOWS\\system32\\cmd.exe", "/d", "/s", "/c", command])
  // The tail is wrapped exactly once and its inner quotes are untouched: with
  // /s cmd strips the first and last quote and takes the rest verbatim.
  // The exe path has no spaces, so quote() correctly leaves it bare.
  expect(line).toBe(`C:\\WINDOWS\\system32\\cmd.exe /d /s /c "${command}"`)
  expect(line).not.toContain('\\"')
})

test("the trailing-backslash case that broke `dir C:\\`", () => {
  const line = AppContainer.commandLine(["cmd.exe", "/d", "/s", "/c", "dir C:\\"])
  // Not `dir C:\\`, which is what doubling the backslash produced.
  expect(line).toBe('cmd.exe /d /s /c "dir C:\\"')
})

test("everything that is not cmd still gets CommandLineToArgvW quoting", () => {
  // The rule is a property of the TARGET's parser, so only cmd is special. A
  // path with a space must still round-trip for python.exe.
  const line = AppContainer.commandLine(["C:\\Py 3\\python.exe", "-c", 'print("hi")'])
  expect(line).toContain('"C:\\Py 3\\python.exe"')
  expect(line).toContain('\\"')
  // And an executable merely named like cmd in an argument does not trigger it.
  expect(AppContainer.commandLine(["python.exe", "/c", "x"])).toBe("python.exe /c x")
})
test("containment is proved by the kernel, not by a command inside the container", async () => {
  // The check used to run `whoami /groups` and pattern-match its output, which
  // made containment depend on a command succeeding INSIDE the container. On a
  // CI runner it does not: whoami resolves SIDs to display names through LSA,
  // which an AppContainer with zero capabilities cannot reach, so it exits 66
  // having printed nothing — while `exit 7` through the identical plan returns
  // 7, proving the container hosts processes perfectly well. Two rounds were
  // spent reading that as a containment failure.
  //
  // The launcher holds the child's process handle, so it asks the kernel
  // TokenIsAppContainer and reports the answer. Nothing depends on what the
  // child can do.
  const launcher = await Bun.file(new URL("../../src/sandbox/appcontainer.ts", import.meta.url).pathname).text()
  expect(launcher).toContain("TOKEN_IS_APP_CONTAINER = 29")
  expect(launcher).toContain("OpenProcessToken")
  expect(launcher).toContain("token appcontainer=")

  const text = await Bun.file(new URL("../../src/sandbox/sandbox.ts", import.meta.url).pathname).text()
  const body = text.slice(text.indexOf("export async function selfTest"))
  expect(body).toContain("OPENSCIENCE_APPCONTAINER_REPORT")
  expect(body).toContain("token appcontainer=")
  // And it no longer asks a child to introspect itself. Comments are not code:
  // the history of why whoami was wrong is worth keeping in the file.
  const code = body
    .split("\n")
    .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
    .join("\n")
  expect(code).not.toContain("whoami")
})

test("a writable path gets a Low mandatory label, not only a DACL grant", async () => {
  // The root cause of "write inside the workspace succeeds" failing, and it is
  // not about paths or quoting, which is what several rounds chased.
  //
  // Every AppContainer runs at Low integrity; a directory created normally is
  // Medium. Mandatory Integrity Control is evaluated BEFORE the DACL, and a
  // Low-integrity principal cannot write to a Medium-integrity object even when
  // the DACL grants it write access. So `/grant *SID:(OI)(CI)(F)` alone could
  // never let the sandbox write anywhere.
  const source = await Bun.file(new URL("../../src/sandbox/appcontainer.ts", import.meta.url).pathname).text()
  // Bounded at the next function, not at quote(): revoke() sits between them and
  // legitimately sets the label back to Medium, which a wider slice misreads as
  // grant() relabelling the READ set.
  const body = source.slice(source.indexOf("export function grant"), source.indexOf("export function removeProfile"))
  expect(body).toContain("/setintegritylevel")
  expect(body).toContain("(OI)(CI)L")
  // Only writable paths are relabelled. Lowering the label on the READ set
  // would let any low-integrity process on the machine modify the interpreter
  // the sandbox then executes — the opposite of the point.
  const relabel = body.indexOf("/setintegritylevel")
  const readGrant = body.indexOf("(OI)(CI)(RX)")
  expect(relabel).toBeLessThan(readGrant)
  expect(body.slice(readGrant)).not.toContain("/setintegritylevel")
})

test("capabilities are granted only for allow, and travel in the spec", () => {
  // `allow` means unrestricted egress on Linux and macOS, so it has to mean that
  // here rather than quietly meaning less — withholding the capabilities would
  // make the knob claim more than it delivers for no security anyone asked for.
  const spec = (network: "deny" | "allowlist" | "allow") =>
    AppContainer.decode(
      Sandbox.appContainerArgs(
        { writable: [], unreadable: [], network, profile: "p", ...(network === "allowlist" ? { egress: "pipe" } : {}) },
        ["x.exe"],
      )[1]!,
    )
  expect(spec("allow").capabilities).toEqual(["S-1-15-3-1", "S-1-15-3-3"])
  // Zero for allowlist is load-bearing, not incidental: the broker is the
  // enforcement point, so a container that could reach the internet directly
  // would route around the allowlist while still reporting a policy was applied.
  expect(spec("allowlist").capabilities).toEqual([])
  expect(spec("deny").capabilities).toEqual([])
})

test("the launcher builds a SID_AND_ATTRIBUTES array, not just a count", async () => {
  // UpdateProcThreadAttribute stores POINTERS; the kernel reads through them at
  // CreateProcess. A capability array built and then dropped would be read after
  // free — the same lifetime rule the SECURITY_CAPABILITIES struct follows.
  const source = await Bun.file(new URL("../../src/sandbox/appcontainer.ts", import.meta.url).pathname).text()
  const body = source.slice(source.indexOf("export function launch"))
  expect(body).toContain("SID_AND_ATTRIBUTES_SIZE")
  expect(body).toContain("SE_GROUP_ENABLED")
  // Held alive alongside the attribute list until after CreateProcess.
  expect(body).toContain("keep.push(granted)")
})

test("allow is not yet a superset of allowlist, and the code says so", async () => {
  // A knob where LOOSENING the policy REMOVES a capability is a design smell.
  // On the other two platforms `allow` applies no network restriction at all
  // (`!== "allow"` guards both --unshare-net and `(deny network*)`), so it is
  // already a superset there; Windows should match rather than invent an
  // ordering of its own.
  //
  // Until the broker lands, `allow` grants capabilities and runs no broker, so
  // localhost is genuinely unreachable and the warning is accurate. This test
  // exists to make the follow-up visible rather than lost: when a broker starts
  // under `allow`, the warning must narrow to non-HTTP.
  const source = await Bun.file(new URL("../../src/sandbox/sandbox.ts", import.meta.url).pathname).text()
  expect(source).toContain("THIS WORDING MUST NARROW")
  // No longer a superset ANYWHERE, which changes what the follow-up is. main
  // severs the network on bubblewrap and denies every socket on seatbelt in
  // every mode, "allow" included, because neither can express "the internet but
  // never host loopback". So Windows is now the only backend where "allow"
  // reaches anything at all, and the three platforms disagree about what the
  // word means. That is the thing to fix — by routing "allow" through the
  // allowlist proxy with an unrestricted host list — and it is tracked here so
  // it stays visible rather than becoming folklore.
  expect(source).toContain('args.push("--unshare-net")')
  expect(source).toContain("(deny default)")
})

test("the pipe never blocks the event loop waiting for a client", async () => {
  // A synchronous blocking Win32 call in a JS process blocks the event loop, so
  // the caller's own timeout can never fire. Measured the hard way: a bare
  // ConnectNamedPipe hung a Windows CI job until the 20-minute job limit, while
  // the test's 120s timeout sat waiting behind the very call it was meant to
  // bound. Non-blocking mode plus a polled deadline is the fix here; the broker
  // proper needs overlapped I/O for the same reason.
  const source = await Bun.file(new URL("../../src/sandbox/appcontainer.ts", import.meta.url).pathname).text()
  expect(source).toContain("PIPE_NOWAIT")
  expect(source).toContain("PIPE_TYPE_BYTE | PIPE_NOWAIT")
  const body = source.slice(source.indexOf("export function pipeEchoOnce"))
  // Every wait is bounded and yields rather than blocking indefinitely.
  expect(body).toContain("timeoutMs")
  expect(body).toContain("Bun.sleepSync")
  expect(body).toContain("no client reached the pipe within")
})

test("what grant() changes, revoke() puts back", async () => {
  // The Low mandatory label is the only way a Low-integrity AppContainer can
  // write anywhere, and it is not a change to make and walk away from: it means
  // ANY low-integrity process on the machine can write there — a sandboxed
  // browser tab, a document preview — and it was being left on the user's own
  // project directory after the run that needed it had exited.
  const source = await Bun.file(new URL("../../src/sandbox/appcontainer.ts", import.meta.url).pathname).text()
  const body = source.slice(source.indexOf("export function revoke"), source.indexOf("SECURITY_ATTRIBUTES_SIZE"))
  // Restored, not merely un-granted.
  expect(body).toContain('"/setintegritylevel", "(OI)(CI)M"')
  expect(body).toContain('"/remove:g"')

  // And it runs on every exit path, including a launch that throws.
  const main = source.slice(source.indexOf("export async function main"))
  expect(main).toContain("finally")
  expect(main.indexOf("finally")).toBeLessThan(main.indexOf("revoke("))
})

test("a throwaway workspace does not orphan an AppContainer profile", async () => {
  // Every self-test run builds a fresh mkdtemp workspace, and the profile name
  // is derived from the workspace — so every run left a profile and an
  // AppData\Local\Packages folder behind. Visible on a real machine as a
  // different package SID in each run's output.
  //
  // A real project must NOT be cleaned up this way: reusing one profile is what
  // keeps its grants stable across runs.
  const source = await Bun.file(new URL("../../src/sandbox/sandbox.ts", import.meta.url).pathname).text()
  const body = source.slice(source.indexOf("export async function selfTest"))
  expect(body).toContain("AppContainer.removeProfile")
  const launcher = await Bun.file(new URL("../../src/sandbox/appcontainer.ts", import.meta.url).pathname).text()
  expect(launcher).toContain("DeleteAppContainerProfile")
})

test("the network probe measures the host before blaming the sandbox", async () => {
  // Two defects a real Windows run exposed, both mine, both the same shape as
  // the ones that cost this feature days.
  //
  // `-o /dev/null` made curl try to create C:\dev\null, so the probe failed for
  // a PATH reason and was reported as a network result — the same POSIX-only
  // assumption that once put `printf` and `cat` into a cmd.exe probe.
  //
  // And the skip message asserted "the container holds no capabilities", which
  // was true when written and became FALSE the moment `allow` started granting
  // internetClient. A diagnostic that states a cause it never measured is
  // exactly the pattern this feature keeps having to unlearn.
  const source = await Bun.file(new URL("../../src/sandbox/sandbox.ts", import.meta.url).pathname).text()
  const body = source.slice(source.indexOf("export async function selfTest"))
  // No output flag at all now. Two probes died on that flag: `-o /dev/null` made
  // curl try to create C:\dev\null, and `-o NUL` then failed INSIDE the
  // container with curl exit 23 (CURLE_WRITE_ERROR) — which means curl connected
  // and received the response and could not write it. The network worked; the
  // probe did not. Both were reported as network results.
  // The command itself, not the body: the comment explaining why `-o` was
  // removed necessarily contains `-o`.
  const command = body.slice(body.indexOf("const curlCmd"), body.indexOf("\n", body.indexOf("const curlCmd")))
  expect(command).toContain("curl -m 5 -sf https://example.com")
  expect(command).not.toContain("-o ")
  expect(body).not.toContain("holds no capabilities")

  // And an exit code that is not a network refusal must not be blamed on the
  // sandbox. 6/7/28 are resolve/connect/timeout; everything else is curl
  // reporting a problem of its own.
  expect(body).toContain("const denied =")
  expect(body).toContain("the probe itself failed under allow")

  // The measurement that makes this assertable rather than inconclusive: ask the
  // HOST first. A sandbox that cannot reach a network the host can reach is a
  // real failure, and on Windows it means the capability grant did not take
  // effect — which is otherwise a silent no-op.
  expect(body).toContain("const reachable")
  expect(body).toContain("network egress works in allow mode")
  expect(body).toContain("the capability grant is not taking effect")
})

test("no line this process wrote is ever reported as the child's error", async () => {
  // Third variant of the same defect. The launcher's debug dump was caught
  // first, so firstLine skipped that one prefix — and then a red CI job
  // reported the reason a sandboxed curl failed as
  //   INFO 2026-08-14 service=openscience api_base=...
  // which is the structured logger, on the same stderr, wearing the child's
  // clothes. Skipping one known prefix is not the fix; skipping anything that
  // came from us is.
  const source = await Bun.file(new URL("../../src/sandbox/sandbox.ts", import.meta.url).pathname).text()
  const body = source.slice(source.indexOf("const ours ="), source.indexOf("function runAsync"))
  expect(body).toContain("openscience[")
  expect(body).toContain("service=openscience")
  expect(body).toContain("INFO|WARN|ERROR|DEBUG")
  // And an empty stderr must still say something: the exit code.
  const check = source.slice(source.indexOf("export async function selfTest"))
  expect(check).toContain("no stderr")
})

test("the broker never blocks, and never leaves the pipe unlistenable", async () => {
  // Every Win32 call the broker makes has to be non-blocking. A bare
  // ConnectNamedPipe once held a CI runner for twenty minutes because the
  // timeout meant to bound it was queued behind it, and the broker runs for the
  // life of a session rather than one measurement.
  const source = await Bun.file(new URL("../../src/sandbox/appcontainer.ts", import.meta.url).pathname).text()
  const body = source.slice(source.indexOf("export function serveBroker"), source.indexOf("export function quote"))
  expect(body).not.toContain("INFINITE")
  expect(body).toContain("setTimeout(pump")

  // A new instance is opened the moment one is accepted. Without that there is
  // a window where the pipe name exists but nothing is listening on it, and a
  // client that arrives in it is refused rather than queued.
  const accept = body.slice(body.indexOf("const accept ="))
  expect(accept.indexOf("links.add(link)")).toBeLessThan(accept.indexOf("listening = openInstance()"))

  // Bytes from the proxy are only written once the socket exists. They can
  // arrive before the dial resolves, and writing them to a handle whose peer has
  // not been dialled yet loses them silently.
  expect(body).toContain("while (link.pending.length && link.socket)")

  // Idle sessions must not pay for a 1ms timer they are not using.
  expect(body).toContain("moved ? 1 : 15")
})

test("the broker's read buffer is allocated once per link and held", async () => {
  // The kernel writes through this pointer. A per-call allocation could be moved
  // by the GC between ffi.ptr() taking its address and ReadFile using it — the
  // same lifetime rule the attribute list and capability array already follow.
  const source = await Bun.file(new URL("../../src/sandbox/appcontainer.ts", import.meta.url).pathname).text()
  const body = source.slice(source.indexOf("export function serveBroker"), source.indexOf("export function quote"))
  const instance = body.slice(body.indexOf("const openInstance"), body.indexOf("const drop"))
  expect(instance).toContain("buffer: new Uint8Array(65536)")
  expect(body).toContain("ffi.ptr(link.buffer)")
})
