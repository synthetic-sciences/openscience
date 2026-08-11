# Windows sandbox — design

Status: proposed, not implemented
Date: 2026-08-11
Branch: `feat/sandbox-network-policy` (Linux and macOS land there; this does not)

## Problem

`sandbox.network` is three-state — `deny | allowlist | allow` — defaulting to `allowlist`, where a sandboxed
process reaches an approved set of hosts and nothing else. Linux enforces this with a network namespace plus a
unix socket; macOS with a seatbelt profile permitting one loopback address.

Windows has neither, and `Sandbox.backend()` returns `"none"` there today. Combined with `enabled: true`,
`available: false` and `onUnavailable: "error"`, that means Windows users cannot use kernels **at all** —
before any of this work. A Linux-only sandbox makes the default policy a lie on the platform with the most
users.

## The guarantee this design targets

> The agent may reach only approved network resources, while OpenScience itself runs **without administrator
> privileges**.

Both halves matter. Dropping the second is easy and unacceptable: OpenScience installs per-user today, and an
application that runs AI-authored code asking for elevation to create a local account and load kernel network
filters is indistinguishable, at the UAC prompt, from malware. Users will refuse, EDR will flag it, and they
will be right to.

## Why not the firewall

The obvious approach — Windows Filtering Platform, a `ALE_AUTH_CONNECT` filter permitting only loopback to a
proxy port — is what `anthropic-experimental/sandbox-runtime` does on Windows. It works, and it requires a
dedicated local user account plus WFP filter installation, hence its one-time elevated `windows-install`.

The model is backwards for us:

```
firewall model:      the machine can reach the network
                     → add rules to restrict this process
                     → requires ADMIN

capability model:    the process cannot reach the network
                     → grant it capabilities explicitly
                     → no machine-level mutation at all
```

The privileged operation in the firewall model is not the restriction. It is the **permission** — Windows will
take all network away for free and charge administrator rights to give one endpoint back.

## Design: AppContainer with no network capability, plus a broker

```
┌──────────────────────────────────────┐
│         OpenScience (normal user)    │
│                                      │
│  ┌────────────────────────────────┐  │
│  │        Policy broker           │  │
│  │  network · filesystem · creds  │──┼──▶ approved hosts
│  └───────────────▲────────────────┘  │
└──────────────────┼───────────────────┘
                   │  named pipe, ACL'd to the AppContainer SID
┌──────────────────┴───────────────────┐
│            Agent sandbox             │
│                                      │
│  AppContainer, low integrity         │
│  network capability: NONE            │
│  filesystem: workspace only          │
│  credentials: none                   │
│                                      │
│    socket("evil.com", 443)   ✗       │
│    socket("8.8.8.8", 53)     ✗       │
│    named pipe → broker       ✓       │
└──────────────────────────────────────┘
```

Three properties, none requiring elevation:

1. **An AppContainer without a network capability has no network.** Kernel-enforced. Not a rule layered over
   an otherwise-connected process — the capability was never granted.
2. **`CreateAppContainerProfile` creates a per-user profile** and returns a stable `S-1-15-2-…` package SID.
   Microsoft's own `mxc` calls it from an ordinary backend, and the SID anchors filesystem ACEs downstream.
3. **Named pipes can be ACL'd to that SID.** Creating the pipe with the right ACL is an ordinary user-mode
   operation, and it is the direct analogue of the bind-mounted unix socket that makes Linux work.

`internetClient` is deliberately **not** granted. It means "outbound internet" wholesale, which cannot express
"github.com yes, `169.254.169.254` no" — exactly the distinction that matters when data exfiltration and SSRF
are in the threat model.

The broker is then a network reference monitor: parse URL → check scheme, host, port, method → apply DNS and
rebinding policy → perform the request → return the response over IPC. The policy engine is the same allowlist
matcher used on Linux and macOS; only the transport differs.

## What this changes about the model, and the cost

Linux and macOS are **socket-transparent**: unmodified `pip`, `curl` and `requests` work, because a shim inside
the sandbox speaks HTTP-proxy protocol and forwards over the socket. That shim needs to listen on loopback.

An AppContainer with no network capability has **no loopback either**, so no shim can exist. Windows is
therefore **capability-mediated**: code must _ask_ the broker, not _connect_.

Better security, worse compatibility. Concretely:

|                                     | Linux / macOS        | Windows                                     |
| ----------------------------------- | -------------------- | ------------------------------------------- |
| Agent tools (`webfetch`, `compute`) | works                | works                                       |
| `pip install` in a kernel           | works via proxy      | **needs the installer outside the sandbox** |
| `requests.get(uniprot)` in a cell   | works                | **blocked**                                 |
| A malicious package phoning home    | bounded by allowlist | blocked outright                            |

Two consequences worth deciding deliberately rather than discovering:

- **Package installation must run in the broker's trust domain**, not inside the AppContainer, with the package
  set already approved by its card. This is what the original spec described before the Linux proxy made a
  separate install path unnecessary; Windows keeps it.
- **A notebook cell cannot fetch a scientific API directly.** For a research product this is a real capability
  gap, and it is the strongest argument against this design. The mitigation is a broker-backed fetch tool the
  agent calls instead of using sockets — which works, but is a different programming model from the other two
  platforms.

## Upgrade path: `Experimental_CreateProcessInSandbox`

Windows 11 exposes `Experimental_CreateProcessInSandbox` from `processmodel.dll`. It composes AppContainer,
filesystem allowlists, integrity level, Win32k and UI restrictions, capabilities, and a `network_policy`
including a **proxy** — very close to this design, natively.

`microsoft/mxc` ships on it: it resolves `processmodel.dll!Experimental_CreateProcessInSandbox` for its "Tier
1" path and falls back to lower tiers when the symbol is absent.

Treat it the same way. It is experimental, subject to change, Windows 11 only, has no public header, and must
be located by dynamic load. Build the broker design as the foundation and adopt the native API as a tier above
it when it stabilises — the tier-fallback pattern is the lesson, not just the API.

## Alternatives considered

| Approach                           | Runtime admin                                              | Network isolation | Per-destination policy | Verdict                                           |
| ---------------------------------- | ---------------------------------------------------------- | ----------------- | ---------------------- | ------------------------------------------------- |
| WFP / firewall rules               | usually yes                                                | strong            | yes                    | rejected — elevation we cannot justify asking for |
| AppContainer + `internetClient`    | no                                                         | strong            | **no**                 | rejected — cannot express an allowlist            |
| **AppContainer + broker**          | **no**                                                     | **strong**        | **strong**             | **proposed**                                      |
| Userspace proxy only, `HTTP_PROXY` | no                                                         | **none**          | yes                    | rejected — advisory; a raw socket ignores it      |
| Restricted token / job object      | no                                                         | **none**          | no                     | rejected — no network isolation at all            |
| Run under WSL2                     | no (WSL install is elevated, but it is Microsoft's prompt) | strong            | strong                 | viable fallback; reuses the Linux path unchanged  |
| Hyper-V / Windows Sandbox          | setup privileged                                           | strong            | yes                    | rejected — heavyweight, Pro/Enterprise only       |

WSL2 deserves a second look before committing to a third backend: where it is present, everything already built
for Linux applies unchanged, and the elevated step belongs to Microsoft's installer rather than ours.

## Verification status

**Nothing in this document has been executed.** There is no Windows machine on this project. Every claim about
Linux in this branch was measured; every claim here is research and reasoning, on the platform where reasoning
has already needed correcting twice.

Before any of it is built, a Windows owner should confirm:

1. `CreateAppContainerProfile` succeeds as a standard user, unelevated.
2. A process in an AppContainer with no network capability genuinely cannot open a socket — including to
   loopback.
3. A named pipe ACL'd to that package SID is reachable from inside, unelevated.
4. Whether _any_ in-container loopback listener is possible, since that single answer decides whether the
   socket-transparent model can be recovered and `pip` can work inside the sandbox after all.

Question 4 is the one that would most change this design.

## Sources

- [CreateProcessInSandbox](https://learn.microsoft.com/en-us/windows/win32/secauthz/createprocessinsandbox)
- [AppContainer for legacy applications](https://learn.microsoft.com/en-us/windows/win32/secauthz/appcontainer-for-legacy-applications-)
- [CreateAppContainerProfile](https://learn.microsoft.com/en-us/windows/win32/api/userenv/nf-userenv-createappcontainerprofile)
- [microsoft/mxc — base process container](https://github.com/microsoft/mxc/blob/main/docs/base-process-container/guide.md)
- [MXC internals](https://www.originhq.com/research/mxc-execution-containers-internals)
- [anthropic-experimental/sandbox-runtime](https://github.com/anthropic-experimental/sandbox-runtime)
- [Tyranid's Lair — UWP localhost network isolation](https://www.tiraniddo.dev/2018/07/uwp-localhost-network-isolation-and-edge.html)
