# Sandbox capability API — design

## Status

Design. Not implemented. Supersedes nothing yet: the current sandbox stays in
place and green while callers migrate to this one, and is deleted when the last
caller moves.

## Why

The sandbox works on Linux and macOS — containment, allowlist egress, and a
governed `pip install` all verified on real CI runners. It does not work on
Windows, and the reason is structural rather than incidental.

Today the sandbox is a **decorator over what the host would have run anyway**:

```ts
Sandbox.plan({ command, shell: Shell.acceptable(), ... })
```

The caller picks the shell, finds the interpreter, and the sandbox wraps
whatever it is handed. That is coherent for **subtract** models — bubblewrap and
seatbelt start from "everything is visible" and remove things, so anything the
host can run, the sandbox can run.

Windows is an **add** model. An AppContainer starts from nothing visible and you
grant upward — and some things can never be granted, because Windows only lets
you modify an ACL you own. So "wrap what the host would have run" is
unsatisfiable by construction whenever the host's choice lives somewhere
unownable.

Every expensive failure on this branch is that one mismatch wearing a different
coat:

| Symptom                                   | Underneath                                                                   |
| ----------------------------------------- | ---------------------------------------------------------------------------- |
| `0xC0000142` from every sandboxed command | `Shell.acceptable()` picks Git Bash under `C:\Program Files`                 |
| `No Python at '…'`, exit 103              | a machine-wide interpreter under `C:\Python312`                              |
| `icacls` sent at `C:\Windows\System32`    | `readable` means visibility on POSIX, a grant list on Windows                |
| `uv trampoline failed to spawn`           | uv's stable interpreter name is a reparse point; only its target was granted |

None of them were predicted. Each was diagnosed from a log after a CI round, and
several were diagnosed **wrongly** first. That is the real cost being designed
away: not the bugs, but that the system could not answer "what can I run here?"
until something crashed.

## What this is not

Two of the constraints are external and no architecture retires them. The design
must accommodate rather than solve them:

- **CPython ≥ 3.12.4's `tempfile.mkdtemp()` is unusable under an AppContainer**
  ([cpython#134587](https://github.com/python/cpython/issues/134587)). Fixed
  upstream, unreleased. It is why Windows installs go through uv.
- **`network: "allow"` is inexpressible on bubblewrap and seatbelt.** Neither can
  grant outbound access without also exposing everything on `127.0.0.1`, so both
  deny every socket in every mode. Only AppContainer capability SIDs make `allow`
  mean anything.

Both are documented today. Neither is in scope to fix.

## Principles

1. **The sandbox declares what it can run; callers choose from that.** Selection
   is inverted. `sandbox.shell()` returns a shell this backend can actually
   execute, not the nicest shell on the machine.
2. **Capability is measured, not assumed.** "Can this be executed / read /
   written here" is a query with a real answer on this machine, not a guess that
   surfaces as a crash three layers away.
3. **One field, one meaning.** Nothing in the policy may mean different things
   per backend.
4. **Refuse loudly and early.** A capability the platform cannot provide is
   reported at the point of asking, with the remedy, not at DLL init.
5. **Backends are replaceable.** Microsoft Execution Containers (MXC, June 2026)
   is an early-preview SDK covering exactly this surface. The seam should let it
   replace the hand-marshalled Win32 FFI without touching a caller.

## The API

Callers state intent. The sandbox resolves platform, backend, shell,
interpreter, grants and egress underneath.

```ts
namespace Sandbox {
  /** What this machine's backend can actually do, measured once per process. */
  export function capabilities(): Capabilities

  export interface Capabilities {
    backend: "bubblewrap" | "seatbelt" | "appcontainer" | "none"
    /** A shell the sandbox can execute, with how to hand it one command. */
    shell: { path: string; invocation: (command: string) => string[] } | undefined
    /** Network policies this backend can honour. "allow" is absent on POSIX. */
    network: Array<"deny" | "allowlist" | "allow">
    /** Whether an arbitrary path can be made reachable at all. */
    canReach(path: string): Reachability
  }

  export type Reachability = { ok: true; cost: "free" | "grant" } | { ok: false; reason: string; remedy?: string }

  /** Run a shell command. The sandbox picks the shell. */
  export function command(input: CommandInput): Spec

  /** Run a program directly (kernels, installers, jobs). */
  export function program(input: ProgramInput): Spec
}
```

`canReach` is the load-bearing addition. On POSIX everything readable is free.
On Windows it answers `{ ok: false, reason: "not owned by you" }` for
`C:\Program Files\Git`, which is how Git Bash gets rejected in `shell()` instead
of at `0xC0000142`.

### Policy fields split by meaning

`readable` becomes two fields, because it always was two things:

| Field     | Meaning                                | POSIX          | Windows                       |
| --------- | -------------------------------------- | -------------- | ----------------------------- |
| `visible` | must be readable by the process        | bind read-only | already reachable, or granted |
| `granted` | must have an ACE naming this container | no-op          | `icacls /grant …:(RX)`        |

The bug this prevents is concrete: main's derived read-roots flowed into
`readable`, and on Windows that meant `icacls` at every directory on `PATH`,
including `C:\Windows\System32`. Unelevated it failed slowly; elevated it would
have succeeded.

### Path identity

Windows needs both the name a caller used **and** what it resolves to. uv keeps a
patch-versioned interpreter directory with a stable name linked beside it;
`pyvenv.cfg` names the stable one, so granting only the resolved target leaves
Python unable to stat the path it actually uses. Linux solves the mirror problem
with mount aliases. The backend owns this translation; callers pass one path.

## Backend contract

A backend implements:

```ts
interface Backend {
  probe(): Capabilities // measured on this machine
  spec(policy: Policy, argv: string[]): Spec
  egress(policy: Policy): EgressRoute | undefined
  cleanup(spec: Spec): void
}
```

Everything platform-specific lives behind it: bubblewrap argv, seatbelt SBPL,
AppContainer SIDs and ACEs. No caller branches on `process.platform`.

## Egress

Today there are three implementations — unix socket plus shim, direct TCP port,
named pipe plus broker plus shim — and the shim's job is identical in two of
them. The broker is the least-proven code in the system and has no equivalent
elsewhere to check it against.

Collapse to **one shim with a pluggable transport**:

```
sandboxed process → loopback → shim → <transport> → host proxy → network
                                       unix socket   (bubblewrap)
                                       direct         (seatbelt, no shim)
                                       named pipe     (appcontainer)
```

The host proxy is unchanged: it enforces the allowlist, requires
`Proxy-Authorization`, and keeps the audit trail. Only the transport differs, and
each transport is tested standalone before anything depends on it.

## Migration

One caller at a time. Each lands green on all three platforms before the next
starts. The old API is deleted when the last caller moves — and if the work
stops early, it stops by reverting the unmigrated half, not by leaving two APIs
in place.

| Order | Caller                                | Why here                                                                     |
| ----- | ------------------------------------- | ---------------------------------------------------------------------------- |
| 1     | `tool/bash.ts`                        | The surface where the Git Bash bug actually bites; migrating it _is_ the fix |
| 2     | `tool/notebook.ts`, `tool/rkernel.ts` | Same shape, adds the interpreter-selection path                              |
| 3     | `compute/jobs.ts`                     | Longest-running consumer; exercises cleanup                                  |
| 4     | `package/installer.ts`                | Depends on interpreter selection being inverted first                        |

## Testing

The rules below come from mistakes made on this branch, each of which cost at
least one CI round.

1. **Every test states its policy.** `trustedSandbox()` defaults to
   `enabled: false`, so a test reading ambient config runs unsandboxed and passes
   vacuously. This happened twice, once printing `Successfully installed
six-1.17.0` from a job whose entire purpose was the sandboxed path.
2. **Every sandboxed test logs its own setup** — shell, argv, grants — before
   asserting. The one test that logged its shell produced trustworthy results;
   the one that did not produced a confident, wrong conclusion.
3. **`CreateProcessW` opens the image in the caller's context.** A launcher
   running as the user spawning a binary _into_ the container proves the launcher
   can open it, not that the container can execute it. Execute-from-inside needs
   its own assertion.
4. **Never assert a mechanism a test did not isolate.** Two conclusions on this
   branch — MIC label propagation, and container execute permission — were
   reported as measured and were wrong, because the test failed for a reason
   other than the hypothesis.
5. **CI for the platform you cannot run locally comes first.** The Windows job
   found six real bugs in its first day, two of them containment holes. Every one
   had been shipped weeks earlier.

## Open questions

- **Windows PowerShell 5.1 only.** `pwsh.exe` (PowerShell 7) lives under
  `C:\Program Files` and is ungrantable — the same trap as Git Bash. `shell()`
  must prefer `System32\WindowsPowerShell\v1.0\powershell.exe` and refuse pwsh 7
  rather than pick it up for being newer.
- **Should managed Windows environments pin CPython 3.12.3?** uv fixes our
  install path; pinning would also fix agent-authored notebook code calling
  `mkdtemp`, at the cost of an interpreter missing months of security fixes.
  Revisit when the upstream fix ships.
- **Does `canReach` need a one-time elevated remedy path?** A user could add
  `ALL APPLICATION PACKAGES:(RX)` to a third-party install once, as an explicit
  opt-in. Out of scope for the first pass; the remedy text should mention it.
