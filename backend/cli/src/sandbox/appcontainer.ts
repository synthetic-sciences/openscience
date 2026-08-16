/**
 * Windows AppContainer launcher.
 *
 * Linux and macOS both have a wrapper executable — `bwrap`, `sandbox-exec` —
 * so confinement is expressible as an argv. Windows has none: it is applied AT
 * process creation, by passing `SECURITY_CAPABILITIES` through
 * `UpdateProcThreadAttribute` to `CreateProcessW`. So the binary launches
 * itself (`openscience __appcontainer-launch <spec> -- <cmd>`, the pattern
 * `__egress-shim` already established) and this module does the Win32 work.
 *
 * Every call is modelled on `docs/specs/windows-appcontainer-probe.ps1`, which
 * ran this exact sequence on a real Windows 11 machine, unelevated, and
 * measured it working: profile creation, a child launched with zero
 * capabilities, that child unable to reach the network, and two children in the
 * same container able to talk over loopback.
 *
 * The x64 struct offsets below are written out beside the fields they belong
 * to rather than derived. Getting one wrong produces a `CreateProcess` failure
 * that reads as a permissions problem rather than a marshalling one, and that
 * is an expensive hour on a machine none of us can debug interactively.
 *
 * The FFI patterns used here — an out-parameter pointer read back with
 * `read.ptr`, and bytes read at a returned pointer with `toArrayBuffer` — were
 * verified against libc on Linux before being written, because the mechanism
 * is the same and the platform is not available to test on.
 */

import { realpathSync } from "fs"

export namespace AppContainer {
  /** What the launcher is told to do, carried as one base64 blob through the
   *  command line. Kept in step with `Sandbox.appContainerArgs`. */
  export type Spec = {
    profile: string
    writable: string[]
    /** Paths the child must READ but not write — its interpreter, above all. */
    readable?: string[]
    unreadable: string[]
    network: "deny" | "allowlist" | "allow"
    /** Well-known capability SIDs to grant. Empty for deny and allowlist. */
    capabilities?: string[]
    /** Broker pipe name, when network is "allowlist". */
    pipe?: string
    /** The host-side proxy the broker relays into. */
    proxy?: { port: number; secret: string }
    /** Argv that starts the shim inside the container. Composed host-side,
     *  because only there is it known whether this is a release (which
     *  re-enters its own binary) or a source checkout (bun plus a bundle). */
    shim?: string[]
    /**
     * How to re-enter this program, as an argv prefix — the binary, plus an
     * entry script when running from source.
     *
     * Carried rather than derived here for two reasons. `process.execPath` is
     * `bun` in a checkout, and `bun __appcontainer-detached ...` is not a valid
     * invocation. And importing the module that knows the difference pulled
     * `Global`'s top-level await into this file's graph, which `bun build
     * --compile` refuses outright — so deriving it here does not merely
     * duplicate a rule, it breaks the release build.
     */
    self?: string[]
  }

  export function decode(blob: string): Spec {
    const value = JSON.parse(Buffer.from(blob, "base64").toString("utf8")) as Spec
    if (!value?.profile) throw new Error("appcontainer spec carries no profile name")
    if (!Array.isArray(value.writable)) throw new Error("appcontainer spec carries no writable list")
    return value
  }

  /** A null-terminated UTF-16LE buffer, which every `...W` entry point expects.
   *  Bun's FFI has no wide-string type, so strings cross as pointers to buffers
   *  the caller keeps alive for the duration of the call. */
  export function wide(value: string) {
    return Buffer.from(`${value}\0`, "utf16le")
  }

  /** Reads a null-terminated UTF-16LE string out of a byte view. */
  export function readWide(bytes: Uint8Array) {
    const chars: number[] = []
    for (let i = 0; i + 1 < bytes.length; i += 2) {
      const code = bytes[i]! | (bytes[i + 1]! << 8)
      if (code === 0) break
      chars.push(code)
    }
    return String.fromCharCode(...chars)
  }

  // ── x64 layouts ───────────────────────────────────────────────────────────
  /** SECURITY_CAPABILITIES { PSID AppContainerSid; PSID_AND_ATTRIBUTES* ; DWORD CapabilityCount; DWORD Reserved } */
  const SECURITY_CAPABILITIES_SIZE = 24
  /** STARTUPINFOW is 104 bytes on x64; STARTUPINFOEXW appends lpAttributeList at 104. */
  const STARTUPINFOEX_SIZE = 112
  const STARTUPINFO_CB_OFFSET = 0
  const STARTUPINFO_FLAGS_OFFSET = 60
  const STARTUPINFO_STDIN_OFFSET = 80
  const STARTUPINFO_STDOUT_OFFSET = 88
  const STARTUPINFO_STDERR_OFFSET = 96
  const STARTUPINFO_ATTRIBUTE_LIST_OFFSET = 104
  const STARTF_USESTDHANDLES = 0x00000100
  const HANDLE_FLAG_INHERIT = 0x00000001
  /** STD_INPUT_HANDLE, STD_OUTPUT_HANDLE, STD_ERROR_HANDLE as unsigned. */
  const STD_HANDLES = { input: 0xfffffff6, output: 0xfffffff5, error: 0xfffffff4 }
  /** PROCESS_INFORMATION { HANDLE hProcess; HANDLE hThread; DWORD pid; DWORD tid } */
  const PROCESS_INFORMATION_SIZE = 24
  const PI_PROCESS_OFFSET = 0

  /** SID_AND_ATTRIBUTES { PSID Sid; DWORD Attributes; } — 8 + 4, padded to 16. */
  const SID_AND_ATTRIBUTES_SIZE = 16
  const SE_GROUP_ENABLED = 0x00000004
  const TOKEN_QUERY = 0x0008
  /** TOKEN_INFORMATION_CLASS.TokenIsAppContainer — a DWORD, 1 inside a container. */
  const TOKEN_IS_APP_CONTAINER = 29
  const PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES = 0x00020009
  const EXTENDED_STARTUPINFO_PRESENT = 0x00080000
  /** HRESULT_FROM_WIN32(ERROR_ALREADY_EXISTS). The profile is per-user state
   *  that outlives a run by design, so this is the ordinary path. */
  const ALREADY_EXISTS = 0x800700b7
  const INFINITE = 0xffffffff

  type Bound = ReturnType<typeof open>

  /**
   * Bound once per process, and kept.
   *
   * `dlopen` returns a library object that owns the handle; only `.symbols` was
   * being kept, so the object was immediately garbage. Bun closes a library when
   * that object is collected, which would unmap the very code a later call jumps
   * into. `main` binds three times over one launch (ensureProfile, grant, launch)
   * and `launch` opened advapi32 a fourth time, so there was ample opportunity.
   * Caching removes the question entirely rather than reasoning about GC timing.
   */
  let bound: Bound | undefined
  function bind(): Bound {
    bound ??= open()
    return bound
  }

  function open() {
    if (process.platform !== "win32") throw new Error("the AppContainer launcher only runs on Windows")
    // Required lazily and by name so `bun:ffi` never enters the module graph on
    // platforms that cannot call this. These DLLs ship with Windows, so nothing
    // additional is distributed.
    const ffi = require("bun:ffi") as typeof import("bun:ffi")
    const t = ffi.FFIType
    const userenv = ffi.dlopen("userenv.dll", {
      CreateAppContainerProfile: { args: [t.ptr, t.ptr, t.ptr, t.ptr, t.u32, t.ptr], returns: t.i32 },
      DeriveAppContainerSidFromAppContainerName: { args: [t.ptr, t.ptr], returns: t.i32 },
      DeleteAppContainerProfile: { args: [t.ptr], returns: t.i32 },
    })
    const advapi = ffi.dlopen("advapi32.dll", {
      ConvertSidToStringSidW: { args: [t.ptr, t.ptr], returns: t.bool },
      ConvertStringSidToSidW: { args: [t.ptr, t.ptr], returns: t.bool },
      FreeSid: { args: [t.ptr], returns: t.ptr },
      ConvertStringSecurityDescriptorToSecurityDescriptorW: { args: [t.ptr, t.u32, t.ptr, t.ptr], returns: t.bool },
      OpenProcessToken: { args: [t.ptr, t.u32, t.ptr], returns: t.bool },
      GetTokenInformation: { args: [t.ptr, t.u32, t.ptr, t.u32, t.ptr], returns: t.bool },
    })
    const kernel = ffi.dlopen("kernel32.dll", {
      LocalFree: { args: [t.ptr], returns: t.ptr },
      GetLastError: { args: [], returns: t.u32 },
      GetStdHandle: { args: [t.u32], returns: t.ptr },
      SetHandleInformation: { args: [t.ptr, t.u32, t.u32], returns: t.bool },
      InitializeProcThreadAttributeList: { args: [t.ptr, t.u32, t.u32, t.ptr], returns: t.bool },
      UpdateProcThreadAttribute: { args: [t.ptr, t.u32, t.u64, t.ptr, t.u64, t.ptr, t.ptr], returns: t.bool },
      DeleteProcThreadAttributeList: { args: [t.ptr], returns: t.void },
      CreateProcessW: {
        args: [t.ptr, t.ptr, t.ptr, t.ptr, t.bool, t.u32, t.ptr, t.ptr, t.ptr, t.ptr],
        returns: t.bool,
      },
      WaitForSingleObject: { args: [t.ptr, t.u32], returns: t.u32 },
      GetExitCodeProcess: { args: [t.ptr, t.ptr], returns: t.bool },
      CloseHandle: { args: [t.ptr], returns: t.bool },
      CreateNamedPipeW: { args: [t.ptr, t.u32, t.u32, t.u32, t.u32, t.u32, t.u32, t.ptr], returns: t.ptr },
      ConnectNamedPipe: { args: [t.ptr, t.ptr], returns: t.bool },
      ReadFile: { args: [t.ptr, t.ptr, t.u32, t.ptr, t.ptr], returns: t.bool },
      WriteFile: { args: [t.ptr, t.ptr, t.u32, t.ptr, t.ptr], returns: t.bool },
      DisconnectNamedPipe: { args: [t.ptr], returns: t.bool },
    })
    // The library objects are returned, not just their symbols, so they stay
    // reachable for the life of the process.
    return {
      ffi,
      libs: [userenv, advapi, kernel],
      userenv: userenv.symbols,
      advapi: advapi.symbols,
      kernel: kernel.symbols,
    }
  }

  /**
   * Can this machine actually be confined by us?
   *
   * Loads the DLLs and derives a SID from a name. That is side-effect free — no
   * profile is created — and it exercises the part most likely to be wrong:
   * whether the FFI bindings resolve and the calling convention is right. A
   * broken binding here is the difference between the sandbox being applied and
   * silently not being.
   *
   * It does NOT prove the launch itself works. That is verified at first use,
   * where `launch` throws with the Win32 error rather than degrading quietly.
   * The alternative — assuming Windows can be confined because the platform
   * says win32 — is how you ship a product that claims a sandbox it never
   * applies.
   */
  export function usable(): boolean {
    if (process.platform !== "win32") return false
    try {
      const b = bind()
      const out = new BigUint64Array(1)
      const hr = b.userenv.DeriveAppContainerSidFromAppContainerName(
        b.ffi.ptr(wide("openscience-capability")),
        b.ffi.ptr(out),
      )
      if (hr !== 0) return false
      const sid = b.ffi.read.ptr(b.ffi.ptr(out), 0)
      if (sid) b.advapi.FreeSid(sid as never)
      return true
    } catch {
      return false
    }
  }

  /**
   * Create the profile if absent, and return its package SID as a string.
   *
   * Idempotent by design. The profile is per-user state that outlives a run,
   * and the SID derived from it is what filesystem ACEs and the broker pipe's
   * DACL refer to — recreating it per launch would strand every grant the
   * previous one made. That is why `Sandbox.appContainerProfile` derives a
   * stable name from the workspace rather than generating one.
   */
  export function ensureProfile(name: string, b: Bound = bind()): string {
    const { ffi, userenv, advapi, kernel } = b
    const wname = wide(name)
    const display = wide(name)
    const description = wide("OpenScience sandbox")
    const sidOut = new BigUint64Array(1)

    let hr = userenv.CreateAppContainerProfile(
      ffi.ptr(wname),
      ffi.ptr(display),
      ffi.ptr(description),
      null,
      0,
      ffi.ptr(sidOut),
    )
    if (hr >>> 0 === ALREADY_EXISTS) {
      hr = userenv.DeriveAppContainerSidFromAppContainerName(ffi.ptr(wname), ffi.ptr(sidOut))
      if (hr !== 0) throw new Error(`DeriveAppContainerSidFromAppContainerName failed: 0x${(hr >>> 0).toString(16)}`)
    } else if (hr !== 0) {
      throw new Error(
        `CreateAppContainerProfile failed: 0x${(hr >>> 0).toString(16)}. Windows sandboxing rests on this call; ` +
          `without it nothing can be confined. It is expected to succeed for a standard user, unelevated.`,
      )
    }

    const sid = ffi.read.ptr(ffi.ptr(sidOut), 0)
    const strOut = new BigUint64Array(1)
    if (!advapi.ConvertSidToStringSidW(sid as never, ffi.ptr(strOut))) {
      throw new Error(`ConvertSidToStringSid failed: Win32 ${kernel.GetLastError()}`)
    }
    const strPtr = ffi.read.ptr(ffi.ptr(strOut), 0)
    // A package SID is well under 512 UTF-16 code units; readWide stops at the
    // first null either way.
    const text = readWide(new Uint8Array(ffi.toArrayBuffer(strPtr as never, 0, 1024)))
    kernel.LocalFree(strPtr as never)
    advapi.FreeSid(sid as never)
    return text
  }

  /**
   * Grant the package SID access to paths the sandboxed process must write.
   *
   * An AppContainer reaches nothing outside its own package folders, so the
   * workspace has to be granted explicitly. `icacls` rather than
   * `SetNamedSecurityInfo` through FFI: it ships with Windows, takes a SID
   * directly in the `*S-1-...` form, and a shelled command that fails is far
   * easier to diagnose than a marshalled ACL that silently grants the wrong
   * thing. The probe measured that the package's OWN temp is already writable
   * with no grant, so only caller-supplied paths are touched.
   *
   * Returns the paths it could not grant rather than throwing: a workspace that
   * is partly ungrantable should still launch and fail visibly at the write,
   * not vanish behind a launcher error.
   */
  /**
   * How many live runs are holding each granted path, keyed `sid\0target`.
   *
   * A profile — and so a package SID — is derived from the workspace, so two
   * concurrent runs in one project share both the SID and the grants. `revoke`
   * was unconditional, which made the first run to finish restore the label and
   * strip the ACE under a second that was still using it: the survivor lost
   * write access to its own workspace partway through, reported as a permission
   * error from whatever it happened to be doing. The agent reaches this
   * routinely — a bash command and a kernel cell overlap all the time.
   *
   * In-process only, which covers that case because both runs are this process.
   * Two separate `openscience` processes on one workspace still race, and fixing
   * that needs an on-disk lock rather than a map; the grant is idempotent and
   * re-applied per run, so the failure there is a transient loss rather than a
   * permanent one.
   */
  const held = new Map<string, number>()
  const key = (sid: string, target: string) => `${sid}\u0000${target}`

  /**
   * The refcount itself, separated from the `icacls` calls it gates.
   *
   * The bookkeeping is the part that can be wrong and the part that has no
   * platform in it; the effect is Windows-only and needs a real ACL. Splitting
   * them means the concurrency rule is testable from any host, which matters
   * because the Windows CI job runs one command at a time and would never
   * exercise an overlap.
   */
  export const Grants = {
    /** Claim `targets` for one run. Distinct targets only — a path in both the
     *  writable and readable lists is one claim, not two. */
    acquire(sid: string, targets: string[]) {
      for (const target of new Set(targets)) held.set(key(sid, target), (held.get(key(sid, target)) ?? 0) + 1)
    },
    /** Release one run's claim; returns the targets no other run still holds,
     *  which are the only ones safe to restore. */
    release(sid: string, targets: string[]) {
      const releasable = new Set<string>()
      for (const target of new Set(targets)) {
        const remaining = (held.get(key(sid, target)) ?? 1) - 1
        if (remaining > 0) {
          held.set(key(sid, target), remaining)
          continue
        }
        held.delete(key(sid, target))
        releasable.add(target)
      }
      return releasable
    },
  }

  export function grant(sid: string, writable: string[], readable: string[] = []) {
    Grants.acquire(sid, [...writable, ...readable])
    const failures: string[] = []
    const unreachable: string[] = []
    // Under OPENSCIENCE_SANDBOX_DEBUG, every ACL change is echoed with its exit
    // code. An `icacls` that exits 0 is not proof the ACE landed where the child
    // needed it, and a `readable` list that arrived here EMPTY is indistinguishable
    // from one that was granted successfully — both are silent. That ambiguity is
    // what left "the launcher cannot spawn its base" undiagnosed across a CI run
    // that otherwise reported everything about the launch.
    const debug = process.env["OPENSCIENCE_SANDBOX_DEBUG"] === "1"
    const say = (line: string) => {
      if (debug) process.stderr.write(`openscience[grant] ${line}\n`)
    }
    say(`writable(${writable.length}): ${writable.join(" | ") || "<none>"}`)
    say(`readable(${readable.length}): ${readable.join(" | ") || "<none>"}`)
    const icacls = (target: string, args: string[]) => {
      const proc = Bun.spawnSync(["icacls.exe", target, ...args, "/Q"], { stdout: "pipe", stderr: "pipe" })
      say(`icacls ${target} ${args.join(" ")} -> exit ${proc.exitCode} ${proc.stderr.toString().trim()}`)
      if (proc.exitCode !== 0) failures.push(`${target}: ${proc.stderr.toString().trim() || `exit ${proc.exitCode}`}`)
    }
    for (const target of writable) {
      // Read-and-execute plus write, for the DACL.
      icacls(target, ["/grant", `*${sid}:(OI)(CI)(F)`])
      // And the mandatory label, WITHOUT WHICH THE GRANT ABOVE DOES NOTHING.
      //
      // Every AppContainer runs at Low integrity; a file or directory created
      // normally is Medium. Mandatory Integrity Control is evaluated BEFORE the
      // DACL, and a Low-integrity principal cannot write to a Medium-integrity
      // object even when the DACL explicitly grants it write access. So the
      // grant above was necessary and never sufficient, and the self-test's
      // "write inside the workspace succeeds" could not pass however the paths
      // were spelled — which is what several rounds of shell-quoting fixes were
      // actually chasing.
      //
      // The cost is real and worth stating: labelling the workspace Low means
      // any OTHER low-integrity process on the machine can write there too — a
      // sandboxed browser tab, say. That is the standard price of an
      // AppContainer-writable directory and what Chromium's sandbox does for the
      // same reason; there is no way to raise an AppContainer above Low. It is
      // applied ONLY to paths already chosen as writable, never to the readable
      // set: lowering the label on an interpreter installation would let any
      // low-integrity process on the machine modify the Python we then execute.
      icacls(target, ["/setintegritylevel", "(OI)(CI)L"])
    }
    // Read AND execute: the interpreter must be runnable, so plain (R) is not
    // enough; never (F), which would hand a sandboxed process write access to
    // the Python installation it is confined away from. No label change —
    // MIC's default policy is no-write-up only, so reading a Medium object
    // from Low is already allowed.
    // Each readable path AND whatever it resolves to. An ACE on a reparse point
    // is not an ACE on its target, and Windows checks the target — so granting
    // only the name we were handed produces a launch that is denied while every
    // command involved reports success.
    //
    // Measured. uv keeps a managed interpreter under a patch-versioned
    // directory and a stable one beside it, and the stable name is a link:
    //
    //   managed interpreter: ...\uv\python\cpython-3.12.14-windows-x86_64-none\python.exe
    //   pyvenv.cfg home    : ...\uv\python\cpython-3.12-windows-x86_64-none
    //
    // `pyvenv.cfg` names the stable one, so that is what we granted. icacls
    // exited 0, and reading the ACL back showed the ACE sitting on it exactly
    // as asked — all true, none of it any use to the container, which exited 53
    // with nothing on either stream.
    const resolve = (target: string) => {
      try {
        const real = realpathSync(target)
        if (real !== target) say(`${target} resolves to ${real}`)
        return real === target ? [target] : [target, real]
      } catch {
        return [target]
      }
    }
    const targets = [...new Set(readable.filter((p) => !writable.includes(p)).flatMap(resolve))]
    for (const target of targets) {
      const before = failures.length
      icacls(target, ["/grant", `*${sid}:(OI)(CI)(RX)`])
      // A failed READ grant is fatal, unlike a failed write grant. It exists
      // only because something in there must be readable — the interpreter,
      // above all — so continuing produces a child that cannot start and an
      // error several layers from its cause. Measured exactly that way: icacls
      // on C:\Python312 denied, then `No Python at ...` and child exit 103,
      // which reads as a broken Python rather than an ungrantable directory.
      if (failures.length > before) unreachable.push(target)
      // The resulting ACL, read back. `icacls /grant` exiting 0 says the command
      // parsed, not that the container can reach anything through it.
      if (debug) {
        const read = Bun.spawnSync(["icacls.exe", target], { stdout: "pipe", stderr: "pipe" })
        for (const line of read.stdout.toString().trim().split("\n")) say(`acl ${line.trim()}`)
      }
    }
    return { failures, unreachable }
  }

  /**
   * Delete a profile and the package folders under it.
   *
   * A profile is per-user state keyed to a name derived from the workspace, so a
   * project reuses one forever and nothing accumulates — that is the design and
   * it is right. What DOES accumulate is profiles for workspaces that were
   * themselves ephemeral: every `sandbox test` run builds a fresh mkdtemp
   * workspace, so every run has orphaned a profile and its
   * `AppData\Local\Packages` folder. Observed as a different package SID on
   * each run of the self-test.
   *
   * Callers that made a throwaway workspace should remove the profile it
   * implied. Callers working in a real project should NOT: the profile is what
   * makes grants stable across runs.
   */
  export function removeProfile(name: string, b: Bound = bind()) {
    const { ffi, userenv } = b
    return userenv.DeleteAppContainerProfile(ffi.ptr(wide(name))) === 0
  }

  /**
   * Put back what `grant` changed.
   *
   * `grant` lowers the workspace's mandatory label to Low, and that is the only
   * way a Low-integrity AppContainer can write anywhere — but it is not a change
   * to make and walk away from. A Low label means ANY low-integrity process on
   * the machine can write there: a sandboxed browser tab, a document preview.
   * Left behind, it outlives the run that needed it and applies to the user's
   * own project directory. The DACL entry is narrower — only our package SID can
   * use it — but there is no reason to leave that either.
   *
   * Medium rather than "no label": a user-created file has no explicit label and
   * is treated as Medium, so this restores the effective behaviour rather than
   * the exact bytes. Worth knowing when reading an ACL afterwards.
   *
   * Best effort, and two limits are worth stating rather than discovering:
   * a killed process never reaches this, and two runs sharing one workspace will
   * have the first to finish restore the label under the second. Both argue for
   * making cleanup idempotent and cheap, which is why failures are collected
   * rather than thrown.
   */
  export function revoke(sid: string, writable: string[], readable: string[] = []) {
    const failures: string[] = []
    // Drop this run's claim, and restore only what no other live run still
    // holds. Decremented once per DISTINCT target, matching `grant`, then both
    // lists are filtered by the result — so a path in both keeps its label
    // restore and its ACE removal together. An unknown key counts as the last
    // holder, so a caller that revokes without having granted through here
    // still cleans up.
    const releasable = Grants.release(sid, [...writable, ...readable])
    writable = writable.filter((target) => releasable.has(target))
    readable = readable.filter((target) => releasable.has(target))
    const icacls = (target: string, args: string[]) => {
      const proc = Bun.spawnSync(["icacls.exe", target, ...args, "/Q"], { stdout: "ignore", stderr: "pipe" })
      if (proc.exitCode !== 0) failures.push(`${target}: ${proc.stderr.toString().trim() || `exit ${proc.exitCode}`}`)
    }
    for (const target of writable) {
      icacls(target, ["/setintegritylevel", "(OI)(CI)M"])
      icacls(target, ["/remove:g", `*${sid}`])
    }
    for (const target of readable.filter((p) => !writable.includes(p))) icacls(target, ["/remove:g", `*${sid}`])
    return failures
  }

  /** SECURITY_ATTRIBUTES { DWORD nLength; LPVOID lpSecurityDescriptor; BOOL bInheritHandle } */
  const SECURITY_ATTRIBUTES_SIZE = 24
  const PIPE_ACCESS_DUPLEX = 0x00000003
  const PIPE_TYPE_BYTE = 0x00000000
  /** Non-blocking mode. Deprecated by Microsoft in favour of overlapped I/O,
   *  and correct here for the same reason overlapped is correct in the broker:
   *  a synchronous blocking Win32 call in a JS process blocks the event loop, so
   *  the caller's own timeout can never fire. Measured the hard way — a bare
   *  ConnectNamedPipe hung a CI job until the 20-minute job limit, because the
   *  test's 120s timeout was waiting behind the call it was meant to bound. */
  const PIPE_NOWAIT = 0x00000001
  const ERROR_PIPE_CONNECTED = 535
  const ERROR_PIPE_LISTENING = 536
  const ERROR_NO_DATA = 232
  const ERROR_BROKEN_PIPE = 109
  const PIPE_UNLIMITED_INSTANCES = 255
  const SDDL_REVISION_1 = 1

  /**
   * A named pipe only this container can open.
   *
   * The DACL is the entire access decision here and deserves the scrutiny the
   * seatbelt profile text gets. The probe measured both halves on a real
   * machine: a pipe with the DEFAULT DACL is denied to the container outright
   * ("Access to the path is denied"), and one granting the package SID connects
   * and sustains 65540 bytes. So this grant is what makes the transport exist,
   * and over-granting it is what would make the sandbox pointless.
   *
   * Written as SDDL rather than assembled from ACE structs: building an ACL
   * through FFI is a lot of pointer arithmetic to express one sentence, and a
   * mistake in it fails OPEN — a wider DACL than intended still works, so
   * nothing would notice. The string says exactly who may connect.
   *
   * Only three principals are named. The package SID is the point. SYSTEM and
   * the local Administrators group are listed because they can open any pipe on
   * the machine whatever we write, so omitting them would imply a restriction
   * that does not exist.
   */
  export function pipeSecurity(sid: string) {
    return `D:(A;;GA;;;${sid})(A;;GA;;;SY)(A;;GA;;;BA)`
  }

  export function pipePath(name: string) {
    return `\\\\.\\pipe\\${name}`
  }

  /** One instance of the broker pipe. The caller owns closing the handle. */
  export function createPipe(name: string, sid: string, b: Bound = bind()) {
    const { ffi, advapi, kernel } = b
    const descriptor = new BigUint64Array(1)
    if (
      !advapi.ConvertStringSecurityDescriptorToSecurityDescriptorW(
        ffi.ptr(wide(pipeSecurity(sid))),
        SDDL_REVISION_1,
        ffi.ptr(descriptor),
        null,
      )
    )
      throw new Error(`Could not build the pipe security descriptor: Win32 ${kernel.GetLastError()}`)
    const attributes = new Uint8Array(SECURITY_ATTRIBUTES_SIZE)
    const view = new DataView(attributes.buffer)
    view.setUint32(0, SECURITY_ATTRIBUTES_SIZE, true)
    view.setBigUint64(8, BigInt(ffi.read.ptr(ffi.ptr(descriptor), 0) as number), true)
    const handle = kernel.CreateNamedPipeW(
      ffi.ptr(wide(pipePath(name))),
      PIPE_ACCESS_DUPLEX,
      PIPE_TYPE_BYTE | PIPE_NOWAIT,
      PIPE_UNLIMITED_INSTANCES,
      65536,
      65536,
      0,
      ffi.ptr(attributes),
    ) as number
    // INVALID_HANDLE_VALUE is -1, which arrives here as an unsafe integer.
    if (!Number.isSafeInteger(handle) || handle <= 0)
      throw new Error(`CreateNamedPipe failed for ${pipePath(name)}: Win32 ${kernel.GetLastError()}`)
    return handle
  }

  /**
   * Block until a client connects, read one chunk, echo it back.
   *
   * Synchronous on purpose: this is the measurement harness that proves the DACL
   * lets the container in, not the broker. The broker needs overlapped I/O and
   * an instance per connection, and building that before knowing the grant works
   * would be the expensive order to find out.
   */
  export function pipeEchoOnce(handle: number, timeoutMs = 20_000, b: Bound = bind()) {
    const { ffi, kernel } = b
    const deadline = Date.now() + timeoutMs
    const waiting = () => {
      if (Date.now() < deadline) return true
      throw new Error(`no client reached the pipe within ${timeoutMs}ms`)
    }
    // Poll, never block. ERROR_PIPE_CONNECTED means a client arrived between
    // creation and this call, which is a success rather than a failure.
    while (!kernel.ConnectNamedPipe(handle as never, null)) {
      if (kernel.GetLastError() === ERROR_PIPE_CONNECTED) break
      if (waiting()) Bun.sleepSync(25)
    }
    const buffer = new Uint8Array(4096)
    const read = new Uint32Array(1)
    while (!kernel.ReadFile(handle as never, ffi.ptr(buffer), buffer.length, ffi.ptr(read), null) || !read[0]) {
      if (waiting()) Bun.sleepSync(25)
    }
    const got = Buffer.from(buffer.slice(0, read[0]!)).toString("utf8")
    const reply = Buffer.from(`echo:${got}`, "utf8")
    const wrote = new Uint32Array(1)
    kernel.WriteFile(handle as never, ffi.ptr(reply), reply.length, ffi.ptr(wrote), null)
    kernel.DisconnectNamedPipe(handle as never)
    return got
  }

  /**
   * The broker: a named pipe only this container can open, relayed to the host
   * proxy over ordinary TCP loopback.
   *
   * Why this shape, all of it measured rather than chosen:
   *
   * - The container cannot reach the host's loopback, and the host cannot reach
   *   a listener the container binds. Isolation runs both ways, so a pipe is the
   *   only transport across the boundary.
   * - The HOST has no such restriction, so `Egress.serveProxy` runs unchanged on
   *   127.0.0.1 exactly as it does for seatbelt, and this relays into it. Host
   *   allowlisting, Proxy-Authorization and the audit trail stay shared with the
   *   other two platforms rather than forked.
   * - The in-container half needs no new code at all: `Bun.connect({unix})` maps
   *   a `\\.\pipe\` path through libuv, so `Egress.serveShim` works verbatim.
   *
   * Polled, not overlapped. Overlapped I/O needs an event object and a wait that
   * a JS event loop cannot participate in; PIPE_NOWAIT plus a timer keeps every
   * Win32 call non-blocking, which is the rule this file already had to learn
   * the hard way — a bare ConnectNamedPipe once held a CI runner for twenty
   * minutes because the timeout meant to bound it was queued behind it.
   *
   * The interval adapts: 1ms while bytes are moving, 15ms when idle. A wheel
   * download is a burst, and paying a busy 1ms timer for the hours a session is
   * idle would be worse than the latency it saves.
   */
  export function serveBroker(input: {
    name: string
    sid: string
    hostname: string
    port: number
    onError?: (message: string) => void
  }) {
    const b = bind()
    const { ffi, kernel } = b
    const report = input.onError ?? (() => {})

    type Link = {
      handle: number
      buffer: Uint8Array
      read: Uint32Array
      wrote: Uint32Array
      socket?: import("bun").Socket<undefined>
      /** Bytes from the proxy waiting for a WriteFile. */
      pending: Uint8Array[]
      /** Bytes read from the pipe before the proxy dial completed. The dial is
       *  async and the client writes its first request immediately, so without
       *  this they were read and dropped — `socket?.write` on an undefined
       *  socket is a silent no-op, and the request that vanished was the CONNECT
       *  line the whole tunnel is built from. */
      outbound: Uint8Array[]
      closing: boolean
    }
    const links = new Set<Link>()
    let listening: Link | undefined
    let stopped = false

    const openInstance = (): Link => ({
      handle: createPipe(input.name, input.sid, b),
      // Allocated once per link and held: the kernel writes through this
      // pointer, so a per-call buffer would be a fresh allocation the GC could
      // move between the pointer being taken and ReadFile using it.
      buffer: new Uint8Array(65536),
      read: new Uint32Array(1),
      wrote: new Uint32Array(1),
      pending: [],
      outbound: [],
      closing: false,
    })

    const drop = (link: Link) => {
      links.delete(link)
      try {
        link.socket?.end()
      } catch {}
      try {
        kernel.DisconnectNamedPipe(link.handle as never)
        kernel.CloseHandle(link.handle as never)
      } catch {}
    }

    /** A client connected: dial the proxy for it, and open the next instance so
     *  the pipe is never momentarily unlistenable. */
    const accept = (link: Link) => {
      links.add(link)
      listening = openInstance()
      Bun.connect<undefined>({
        hostname: input.hostname,
        port: input.port,
        socket: {
          data: (_socket, chunk) => {
            link.pending.push(new Uint8Array(chunk))
          },
          close: () => {
            link.closing = true
          },
          error: (_socket, error) => {
            report(`broker upstream error: ${error.message}`)
            link.closing = true
          },
          open: () => {},
        },
      }).then(
        (socket) => {
          if (stopped || link.closing) return socket.end()
          link.socket = socket
          // Anything read while the dial was in flight, in arrival order.
          for (const chunk of link.outbound.splice(0)) socket.write(chunk)
        },
        (error: Error) => {
          report(`broker could not reach the proxy at ${input.hostname}:${input.port}: ${error.message}`)
          drop(link)
        },
      )
    }

    const pump = () => {
      let moved = false
      if (listening) {
        const connected = kernel.ConnectNamedPipe(listening.handle as never, null)
        const why = connected ? 0 : kernel.GetLastError()
        if (connected || why === ERROR_PIPE_CONNECTED) {
          accept(listening)
          moved = true
        } else if (why !== ERROR_PIPE_LISTENING && why !== ERROR_NO_DATA) {
          report(`broker ConnectNamedPipe failed: Win32 ${why}`)
        }
      }
      for (const link of [...links]) {
        // Pipe -> proxy.
        const ok = kernel.ReadFile(
          link.handle as never,
          ffi.ptr(link.buffer),
          link.buffer.length,
          ffi.ptr(link.read),
          null,
        )
        if (ok && link.read[0]) {
          const chunk = link.buffer.slice(0, link.read[0]!)
          if (link.socket) link.socket.write(chunk)
          else link.outbound.push(chunk)
          moved = true
        } else if (!ok && kernel.GetLastError() === ERROR_BROKEN_PIPE) {
          drop(link)
          continue
        }
        // Proxy -> pipe. Only once the socket exists, or bytes that arrive
        // before the dial completes would be written to a handle whose peer has
        // not been told anything yet.
        while (link.pending.length && link.socket) {
          const chunk = link.pending.shift()!
          if (!kernel.WriteFile(link.handle as never, ffi.ptr(chunk), chunk.length, ffi.ptr(link.wrote), null)) {
            const why = kernel.GetLastError()
            if (why === ERROR_BROKEN_PIPE) {
              drop(link)
              break
            }
            report(`broker WriteFile failed: Win32 ${why}`)
            // Put it back. Every non-fatal failure here is transient (a full
            // pipe buffer), and discarding the chunk corrupts the stream rather
            // than slowing it down.
            link.pending.unshift(chunk)
            break
          }
          // A short write is NORMAL on this handle, not an error. The pipe is
          // PIPE_NOWAIT, where WriteFile documents returning TRUE having written
          // fewer bytes than asked — zero of them when the buffer is full. The
          // count was written to `link.wrote` and never read, so a busy pipe
          // silently truncated whatever the proxy sent: a body short its tail,
          // or a response head cut mid-header, both of which read downstream as
          // a corrupt server rather than as backpressure.
          const written = link.wrote[0] ?? 0
          if (written < chunk.length) {
            link.pending.unshift(chunk.slice(written))
            if (written) moved = true
            break
          }
          moved = true
        }
        if (link.closing && !link.pending.length) drop(link)
      }
      timer = setTimeout(pump, moved ? 1 : 15)
    }

    listening = openInstance()
    let timer = setTimeout(pump, 1)

    return {
      pipe: pipePath(input.name),
      stop() {
        stopped = true
        clearTimeout(timer)
        for (const link of [...links]) drop(link)
        if (listening) {
          try {
            kernel.CloseHandle(listening.handle as never)
          } catch {}
          listening = undefined
        }
      },
    }
  }

  /**
   * Stand up the egress path for one launch, and return how to tear it down.
   *
   * Order matters and is not arbitrary. The pipe must exist before the shim
   * dials it, the shim must be listening before the payload is told to use it,
   * and `HTTP_PROXY` is set on THIS process rather than passed as an
   * environment block because the payload inherits our environment — which
   * saves marshalling a UTF-16 block through FFI for one variable.
   */
  async function bridgeEgress(sid: string, spec: Spec) {
    const broker = serveBroker({
      name: spec.pipe!,
      sid,
      hostname: "127.0.0.1",
      port: spec.proxy!.port,
      onError: (message) => process.stderr.write(`openscience: ${message}\n`),
    })

    // A port the shim binds INSIDE the container. An AppContainer shares the
    // host's network stack rather than getting a namespace, so a port free here
    // is free there — and a fixed one (as bubblewrap's SHIM_PORT is) could
    // collide with whatever else is on the machine.
    const probe = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } })
    const port = probe.port
    probe.stop(true)

    // No fallback to a locally composed argv. Guessing `process.execPath` here
    // is what produced `Script not found "__egress-shim"` and a dead proxy port
    // under `bun test`, and a silent wrong guess is worse than a loud absence.
    if (!spec.shim) throw new Error("sandbox: allowlist egress requires a shim argv in the spec")
    if (!spec.self) throw new Error("sandbox: allowlist egress requires a re-entry argv in the spec")
    // Started inside the workspace, which is granted by construction.
    const shim = launchDetached(spec.self, sid, [...spec.shim, String(port), broker.pipe], [], spec.writable[0])
    // The payload inherits this. `os:<secret>` is the same Proxy-Authorization
    // seatbelt uses, and the shim relays bytes without interpreting them, so the
    // credential travels end to end unchanged.
    const url = `http://os:${spec.proxy!.secret}@127.0.0.1:${port}`
    for (const key of ["HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy"]) process.env[key] = url

    return {
      stop() {
        try {
          shim.kill()
        } catch {}
        broker.stop()
      },
    }
  }

  /**
   * Quote one argument the way `CommandLineToArgvW` will parse it back.
   *
   * Windows has no argv: `CreateProcess` takes a single string and the child
   * re-splits it. The rules are neither the shell's nor POSIX's — backslashes
   * are literal except immediately before a quote, where they double. Getting
   * this wrong on a path like `C:\Users\me\My Project\` silently changes what
   * the child runs, which is the whole reason the sandbox spec travels as
   * base64 rather than as flags.
   */
  export function quote(value: string) {
    if (value.length && !/[\s"]/.test(value)) return value
    let out = '"'
    let slashes = 0
    for (const ch of value) {
      if (ch === "\\") {
        slashes++
        continue
      }
      if (ch === '"') {
        out += "\\".repeat(slashes * 2 + 1) + '"'
        slashes = 0
        continue
      }
      out += "\\".repeat(slashes) + ch
      slashes = 0
    }
    return `${out}${"\\".repeat(slashes * 2)}"`
  }

  export function commandLine(argv: string[]) {
    // cmd.exe is the exception to `quote`, and it fails in a way that reads as
    // a broken sandbox. It does NOT parse its `/c` tail with
    // `CommandLineToArgvW` and does not recognise a backslash-escaped quote, so
    // quoting the tail the normal way produced, on a real machine:
    //   echo hi>"C:\...\probe"   ->   "echo hi>\"C:\...\probe\""
    // and cmd read the backslashes literally, answering "The filename,
    // directory name, or volume label syntax is incorrect." The same shape turned
    // `dir C:\` into `dir C:\\`.
    //
    // With `/s` cmd strips exactly the first and last quote and takes the rest
    // verbatim, so the tail is wrapped once and left alone. This is what Node
    // does for every Windows spawn.
    const at = argv.findIndex((value) => value.toLowerCase() === "/c")
    if (at > 0 && /(^|[\\/])cmd(\.exe)?$/i.test(argv[0] ?? "")) {
      return `${argv
        .slice(0, at + 1)
        .map(quote)
        .join(" ")} "${argv.slice(at + 1).join(" ")}"`
    }
    return argv.map(quote).join(" ")
  }

  /**
   * Launch `argv` inside the AppContainer for `sid`, with NO capabilities, and
   * return its exit code.
   *
   * Zero capabilities is the entire point: no `internetClient`, nothing. The
   * probe measured that such a container reaches no external host, no host
   * loopback listener, and resolves no DNS, while remaining able to talk to
   * another process in the same container over loopback — which is what makes
   * the shim model viable here.
   */
  /**
   * Start a child in the container WITHOUT waiting for it.
   *
   * The shim has to be running before the payload starts, and it never exits on
   * its own — it serves until the container goes away. `launch` waits, which is
   * right for the payload and would deadlock here.
   */
  export function launchDetached(
    self: string[],
    sid: string,
    argv: string[],
    capabilities: string[] = [],
    cwd?: string,
    /** "inherit" for the payload, whose output is the point; "ignore" for the
     *  shim, which has none worth carrying. */
    stdout: "ignore" | "inherit" = "ignore",
  ) {
    // A helper process, not a thread: `launch` blocks on WaitForSingleObject and
    // bun:ffi has no way to run that off the event loop. So the shim gets its
    // own host process whose whole job is to hold that wait, and killing it is
    // what tears the shim down.
    //
    // `cwd` is not cosmetic. CreateProcessW inherits the parent's working
    // directory, and this helper's parent is the launcher, whose cwd is wherever
    // the user happened to run from -- a path the container is not granted. The
    // process is created (`CreateProcessW -> true`) and then dies on its first
    // syscall, which for bun reads:
    //
    //     error loading current directory
    //
    // with nothing else on either stream. So the shim must start somewhere the
    // container can actually reach, which is what this passes down.
    return Bun.spawn([...self, "__appcontainer-detached", sid, JSON.stringify(capabilities), cwd ?? "", ...argv], {
      stdout,
      stderr: "inherit",
      ...(cwd ? { cwd } : {}),
    })
  }

  export function launch(
    sid: string,
    argv: string[],
    capabilities: string[] = [],
    b: Bound = bind(),
    cwd?: string,
  ): number {
    const { ffi, advapi, kernel } = b
    // Set OPENSCIENCE_SANDBOX_DEBUG=1 to dump every intermediate value.
    //
    // `sandbox test` has now proved the child runs UNCONFINED: CreateProcess
    // succeeds, the command executes, and the token carries no package SID. The
    // probe ran this same sequence successfully in PowerShell on the same
    // machine, so the difference is in what we hand the kernel, not in what the
    // kernel supports. Guessing at that across a rebuild cycle each time has
    // been the expensive part; this makes one run answer it.
    const debug = process.env["OPENSCIENCE_SANDBOX_DEBUG"] === "1"
    const say = (line: string) => {
      if (debug) process.stderr.write(`openscience[appcontainer] ${line}\n`)
    }
    const bytes = (view: Uint8Array) => Buffer.from(view).toString("hex")
    const keep: unknown[] = []

    const sidBuf = new BigUint64Array(1)
    // ConvertStringSidToSidW comes from the cached binding now. Opening
    // advapi32 a second time here left a library object nothing referenced.
    if (!advapi.ConvertStringSidToSidW(ffi.ptr(wide(sid)), ffi.ptr(sidBuf))) {
      throw new Error(`ConvertStringSidToSid failed for ${sid}: Win32 ${kernel.GetLastError()}`)
    }
    const sidPtr = ffi.read.ptr(ffi.ptr(sidBuf), 0)
    say(`sid ${sid} -> 0x${(sidPtr as number).toString(16)}`)

    // Size the attribute list, then allocate and initialise it. The first call
    // is expected to fail with ERROR_INSUFFICIENT_BUFFER; only the size matters.
    const sizeOut = new BigUint64Array(1)
    kernel.InitializeProcThreadAttributeList(null, 1, 0, ffi.ptr(sizeOut))
    const listSize = Number(sizeOut[0]!)
    say(`attribute list size ${listSize}`)
    if (!listSize) throw new Error("InitializeProcThreadAttributeList reported a zero-length attribute list")
    const attributes = new Uint8Array(listSize)
    if (!kernel.InitializeProcThreadAttributeList(ffi.ptr(attributes), 1, 0, ffi.ptr(sizeOut))) {
      throw new Error(`InitializeProcThreadAttributeList failed: Win32 ${kernel.GetLastError()}`)
    }

    // The capability array, when the policy grants any.
    //
    // Zero capabilities is the containment for `deny` and `allowlist`; `allow`
    // grants internetClient and privateNetworkClientServer so it means what it
    // says. Each entry is a SID_AND_ATTRIBUTES, and the SIDs must outlive the
    // call for the same reason the struct below does — the kernel reads through
    // these pointers at CreateProcess, not at UpdateProcThreadAttribute.
    const granted = new Uint8Array(Math.max(1, capabilities.length) * SID_AND_ATTRIBUTES_SIZE)
    const grantedView = new DataView(granted.buffer)
    capabilities.forEach((name, i) => {
      const out = new BigUint64Array(1)
      if (!advapi.ConvertStringSidToSidW(ffi.ptr(wide(name)), ffi.ptr(out))) {
        throw new Error(`ConvertStringSidToSid failed for capability ${name}: Win32 ${kernel.GetLastError()}`)
      }
      keep.push(out)
      grantedView.setBigUint64(i * SID_AND_ATTRIBUTES_SIZE, BigInt(ffi.read.ptr(ffi.ptr(out), 0) as number), true)
      grantedView.setUint32(i * SID_AND_ATTRIBUTES_SIZE + 8, SE_GROUP_ENABLED, true)
    })
    keep.push(granted)
    say(`capabilities requested: ${capabilities.length ? capabilities.join(", ") : "none"}`)

    const security = new Uint8Array(SECURITY_CAPABILITIES_SIZE)
    new DataView(security.buffer).setBigUint64(0, BigInt(sidPtr as number), true)
    if (capabilities.length) {
      new DataView(security.buffer).setBigUint64(8, BigInt(ffi.ptr(granted) as number), true)
      new DataView(security.buffer).setUint32(16, capabilities.length, true)
    }
    // For deny and allowlist the Capabilities pointer stays null and the count
    // stays 0 — that is the containment, and under allowlist it is what forces
    // traffic through the broker instead of around it.
    //
    // These two buffers must outlive the call: UpdateProcThreadAttribute stores
    // a POINTER to `capabilities` inside `attributes`, and does not copy it, so
    // the value has to still be there when CreateProcess reads the list. C# uses
    // AllocHGlobal for exactly this reason. Holding both in `keep` makes the
    // lifetime explicit rather than relying on them merely still being in scope.
    keep.push(attributes, security, sidBuf)
    say(`security capabilities ${bytes(security)}`)
    say(`attributes at 0x${(ffi.ptr(attributes) as number).toString(16)}`)

    if (
      !kernel.UpdateProcThreadAttribute(
        ffi.ptr(attributes),
        0,
        BigInt(PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES) as never,
        ffi.ptr(security),
        BigInt(SECURITY_CAPABILITIES_SIZE) as never,
        null,
        null,
      )
    ) {
      throw new Error(`UpdateProcThreadAttribute failed: Win32 ${kernel.GetLastError()}`)
    }

    const startup = new Uint8Array(STARTUPINFOEX_SIZE)
    const startupView = new DataView(startup.buffer)
    startupView.setUint32(STARTUPINFO_CB_OFFSET, STARTUPINFOEX_SIZE, true)
    startupView.setBigUint64(STARTUPINFO_ATTRIBUTE_LIST_OFFSET, BigInt(ffi.ptr(attributes)), true)

    // Hand the child our own std handles, and let it inherit them.
    //
    // `bInheritHandles: false` was silently fatal in a way that looked exactly
    // like a containment failure. The launcher is spawned with its stdout on a
    // PIPE, and a child inheriting nothing has nowhere to write, so every
    // sandboxed command produced empty output. The first Windows self-test read
    // that empty stdout, found no package SID in it, and reported the container
    // as not applied — when the token may have been correct and merely
    // unreadable. Two different bugs with one observable, which is precisely
    // what the token check was added to prevent, so the check now reports the
    // child's exit status and stderr as well.
    //
    // This is not a test-only concern. Every sandboxed command's output crosses
    // this boundary: pip's progress, a bash tool's result, a kernel's stream.
    const inherit = (id: number) => {
      const h = kernel.GetStdHandle(id) as number
      // GetStdHandle answers 0 for "none" and INVALID_HANDLE_VALUE for failure;
      // the latter is -1, which arrives here as an unsafe integer.
      if (!Number.isSafeInteger(h) || h <= 0) return 0n
      // Inheritance is a property of the handle in THIS process, and the ones
      // we were given are not necessarily marked for it.
      kernel.SetHandleInformation(h as never, HANDLE_FLAG_INHERIT, HANDLE_FLAG_INHERIT)
      return BigInt(h)
    }
    const stdout = inherit(STD_HANDLES.output)
    const stderr = inherit(STD_HANDLES.error)
    // Only claim the handles when there is something to claim: with the flag
    // set and a null handle the child gets no stdout at all, which is the very
    // failure this replaces. Without it the child attaches to our console,
    // which is the right fallback when we have one.
    if (stdout && stderr) {
      startupView.setUint32(STARTUPINFO_FLAGS_OFFSET, STARTF_USESTDHANDLES, true)
      startupView.setBigUint64(STARTUPINFO_STDIN_OFFSET, inherit(STD_HANDLES.input), true)
      startupView.setBigUint64(STARTUPINFO_STDOUT_OFFSET, stdout, true)
      startupView.setBigUint64(STARTUPINFO_STDERR_OFFSET, stderr, true)
    }

    const info = new Uint8Array(PROCESS_INFORMATION_SIZE)
    // Mutable: CreateProcessW may write into lpCommandLine.
    const line = wide(commandLine(argv))
    // lpCurrentDirectory, explicitly.
    //
    // Passing null means "inherit the parent's", which is a path chosen by
    // whoever launched us and is routinely one the container has no grant for.
    // The child is then created successfully and dies on its first syscall —
    // for bun, `error loading current directory` and nothing else. Setting the
    // parent's cwd instead of this argument was not enough, so the value the
    // kernel receives is now the value we chose, and it is logged.
    const directory = cwd ? wide(cwd) : undefined
    keep.push(startup, info, line)
    if (directory) keep.push(directory)
    say(`current directory ${cwd ?? "<inherited>"}`)
    // The whole STARTUPINFOEX as the kernel will read it. cb must be 0x70 (112)
    // in the first four bytes, and the attribute-list pointer must be non-zero
    // at offset 104 — if either is wrong, CreateProcess ignores the list and
    // succeeds anyway, which is precisely the failure being chased.
    say(`startupinfoex ${bytes(startup)}`)
    say(`  cb=${new DataView(startup.buffer).getUint32(STARTUPINFO_CB_OFFSET, true)} (expect ${STARTUPINFOEX_SIZE})`)
    say(
      `  lpAttributeList=0x${new DataView(startup.buffer).getBigUint64(STARTUPINFO_ATTRIBUTE_LIST_OFFSET, true).toString(16)}`,
    )
    say(`commandline ${commandLine(argv)}`)
    say(`creationflags 0x${EXTENDED_STARTUPINFO_PRESENT.toString(16)} (EXTENDED_STARTUPINFO_PRESENT)`)

    const ok = kernel.CreateProcessW(
      null,
      ffi.ptr(line),
      null,
      null,
      true,
      // No CREATE_UNICODE_ENVIRONMENT: lpEnvironment below is null, so the child
      // inherits ours and the flag would describe a block never supplied.
      EXTENDED_STARTUPINFO_PRESENT,
      null,
      directory ? ffi.ptr(directory) : null,
      ffi.ptr(startup),
      ffi.ptr(info),
    )
    say(`CreateProcessW -> ${ok} (Win32 ${ok ? 0 : kernel.GetLastError()})`)
    // Ask the KERNEL whether the child is contained, rather than asking the
    // child to introspect itself.
    //
    // The self-test ran `whoami /groups` and pattern-matched its output, which
    // made containment depend on a command succeeding INSIDE the container. On a
    // CI runner it does not: `whoami /groups` resolves SIDs to display names
    // through LSA, which an AppContainer with zero capabilities cannot reach, so
    // it exits 66 with no output — while `exit 7` through the identical plan
    // returns 7, proving the container hosts processes perfectly well. Two
    // rounds were spent reading that as a containment failure.
    //
    // We hold the process handle, so TokenIsAppContainer answers directly and
    // cannot be confounded by what the child can or cannot do. Queried before
    // the wait: the handle keeps the process object alive either way, but a
    // token query on a live process is the case Windows documents.
    if (ok && process.env["OPENSCIENCE_APPCONTAINER_REPORT"] === "1") {
      const child = ffi.read.ptr(ffi.ptr(info), PI_PROCESS_OFFSET)
      const tokenOut = new BigUint64Array(1)
      if (advapi.OpenProcessToken(child as never, TOKEN_QUERY, ffi.ptr(tokenOut))) {
        const token = ffi.read.ptr(ffi.ptr(tokenOut), 0)
        const valueOut = new Uint32Array(1)
        const lenOut = new Uint32Array(1)
        const read = advapi.GetTokenInformation(
          token as never,
          TOKEN_IS_APP_CONTAINER,
          ffi.ptr(valueOut),
          4,
          ffi.ptr(lenOut),
        )
        process.stderr.write(`openscience[appcontainer] token appcontainer=${read ? valueOut[0] : "?"}\n`)
        kernel.CloseHandle(token as never)
      } else {
        process.stderr.write(
          `openscience[appcontainer] token appcontainer=? (OpenProcessToken Win32 ${kernel.GetLastError()})\n`,
        )
      }
    }
    // Only now is the attribute list dead. Referenced here so nothing above can
    // be considered unreachable while the kernel still holds pointers into it.
    kernel.DeleteProcThreadAttributeList(ffi.ptr(attributes))
    keep.length = 0
    if (!ok) {
      throw new Error(
        `CreateProcess into the AppContainer failed: Win32 ${kernel.GetLastError()}. ` +
          `Win32 5 is access denied; 2 means the executable was not found; ` +
          // 203 was the one actually hit on a real machine, and it was not in
          // this list, so the number carried no meaning at the point of failure.
          // lpApplicationName is null, so Windows resolves argv[0] itself and
          // needs an environment to do it in.
          `203 is ERROR_ENVVAR_NOT_FOUND, which points at the environment this ` +
          `process was given rather than at the command.`,
      )
    }

    const handle = ffi.read.ptr(ffi.ptr(info), PI_PROCESS_OFFSET)
    const waited = kernel.WaitForSingleObject(handle as never, INFINITE)
    const codeOut = new Uint32Array(1)
    const got = kernel.GetExitCodeProcess(handle as never, ffi.ptr(codeOut))
    // The debug trail stopped at CreateProcess, so a child that started and then
    // died told us only "no output". On a CI runner the child exits 66 with
    // nothing on either stream, where the same build on a developer machine
    // produces a Low-integrity token — so what happens BETWEEN start and exit is
    // the whole question. WaitForSingleObject answers 0 for a real exit and
    // 0x102 for a timeout we never asked for; a false GetExitCodeProcess means
    // the code below is not the child's at all.
    say(`wait -> ${waited}, GetExitCodeProcess -> ${got}, child exit ${codeOut[0]}`)
    kernel.CloseHandle(handle as never)
    return codeOut[0]!
  }

  /**
   * The `__appcontainer-launch` entry point: decode the spec, ensure the
   * profile, grant the workspace, run the real command, propagate its exit
   * code.
   *
   * Grant failures are reported on stderr rather than thrown. The command
   * should still run and fail visibly at the write it cannot make, rather than
   * disappearing behind a launcher error that says nothing about what the user
   * actually asked for.
   */
  export async function main(blob: string, argv: string[]): Promise<number> {
    const spec = decode(blob)
    const sid = ensureProfile(spec.profile)
    const { failures, unreachable } = grant(sid, spec.writable, spec.readable ?? [])
    for (const failure of failures) process.stderr.write(`openscience: could not grant sandbox access to ${failure}\n`)
    if (unreachable.length) {
      // Almost always ownership: `icacls` can only change an ACL the caller
      // owns, and an all-users Python under C:\ belongs to SYSTEM and the
      // Administrators group. So a machine-wide interpreter can never be made
      // readable to an AppContainer without elevation, which this product does
      // not ask for. Say that, with the remedy, rather than letting it surface
      // as a Python that cannot start.
      throw new Error(
        [
          `The sandbox cannot be given read access to: ${unreachable.join(", ")}.`,
          "icacls can only change an ACL you own, and an all-users install under C:\\ is owned by SYSTEM.",
          "Use a Python you own instead - install it for your user (the python.org installer's",
          "'Install for all users' left OFF puts it under %LOCALAPPDATA%\\Programs\\Python), or install uv",
          "and let OpenScience provision one. Either lives under your profile, where the grant succeeds.",
        ].join("\n"),
      )
    }
    // Bounded egress: a pipe only this container can open, a broker relaying it
    // to the host proxy, and a shim inside the container giving the payload the
    // host:port it expects. Each hop was measured before any of it was written;
    // see docs/specs/windows-egress-design.md.
    const bridge = spec.pipe && spec.proxy ? await bridgeEgress(sid, spec) : undefined
    try {
      // Without a broker, block here: one process, one wait, nothing to starve.
      if (!bridge) return launch(sid, argv, spec.capabilities ?? [])
      // With one, the payload needs its own process for the same reason the shim
      // already had one. `launch` waits on WaitForSingleObject(INFINITE) through
      // FFI, which bun cannot move off the event loop — and the broker's pump is
      // a setTimeout in THIS process. So relaying stopped the instant the
      // payload started, and pip saw a tunnel that connected and then delivered
      // nothing:
      //
      //     ReadTimeoutError("HTTPSConnectionPool(host='pypi.org', port=443):
      //     Read timed out. (read timeout=15)")
      //
      // `launchDetached` was written for exactly this hazard and applied only to
      // the shim. stdout is inherited rather than ignored here because this one
      // is the payload, and its output is the point.
      return await launchDetached(spec.self!, sid, argv, spec.capabilities ?? [], undefined, "inherit").exited
    } finally {
      bridge?.stop()
      // Always, including when launch throws. The Low label is the part that
      // must not outlive the run: it opens the workspace to every low-integrity
      // process on the machine, not just to us.
      for (const failure of revoke(sid, spec.writable, spec.readable ?? []))
        process.stderr.write(`openscience: could not restore ${failure}\n`)
    }
  }
}
