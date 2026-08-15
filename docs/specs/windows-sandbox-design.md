# Windows sandbox — design

Status: proposed, not implemented. Core transport claim MEASURED 2026-08-12 — and the original claim was wrong.
Date: 2026-08-11 (revised 2026-08-12)
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

1. **An AppContainer without a network capability has no network _off the machine_.** Kernel-enforced. Not a
   rule layered over an otherwise-connected process — the capability was never granted. Measured: external
   connect denied, host-loopback denied, DNS denied. **But loopback _inside_ the container is not filtered** —
   two processes sharing the package SID talk freely, which is what makes the shim model work here (see "What
   this changes about the model"). "No network" is the right summary for the threat model and the wrong summary
   for the transport design; both matter.
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

**This section previously claimed Windows could not do that, and it was wrong.** It asserted that an
AppContainer with no network capability has no loopback either, so no shim could exist, and concluded that
Windows had to be capability-mediated — a different programming model, with package installation pushed into
the broker's trust domain and notebook cells unable to fetch anything. That was reasoning, not measurement.

`windows-appcontainer-probe.ps1` measured it on Windows 11 (10.0.26200), unelevated, with MpsSvc running and
all three firewall profiles enabled. **Loopback works inside an AppContainer, including between two separate
processes carrying the same package SID** — 8192 bytes echoed and content-verified, with the listener recording
a real peer endpoint. The whole chain the design depends on holds end to end:

```
pip --(loopback, cross-process)--> shim --(named pipe)--> broker --> network
      MEASURED: 8 KiB verified          MEASURED: 64 KiB each way
```

So Windows can be socket-transparent exactly like the other two platforms, and the compatibility table this
section used to carry is deleted rather than corrected — every row of it was a consequence of the false premise.

**What the probe measured, with its controls:**

| Claim                                                  | Result | Control that makes it mean something                                     |
| ------------------------------------------------------ | ------ | ------------------------------------------------------------------------ |
| `CreateAppContainerProfile` unelevated                 | works  | script refuses to interpret a run as Administrator                       |
| loopback bind + listen inside the container            | works  | —                                                                        |
| loopback round trip **across two processes**, same SID | works  | real peer endpoint recorded, payload byte-verified                       |
| named pipe ACL'd to the package SID                    | works  | a **default-DACL** pipe was refused, so the grant is what did the work   |
| that pipe as a real transport                          | works  | 64 KiB each way interleaved, content-verified, host agreed (65540 bytes) |
| outbound to `1.1.1.1:443` with zero capabilities       | denied | MpsSvc running and all firewall profiles on                              |
| reaching a listener on the **host** loopback           | denied | machine carries 2 unrelated loopback exemptions; ours was not one        |
| DNS inside the container                               | denied | host resolves `pypi.org` fine, container does not                        |
| reading or writing the user profile                    | denied | System32 stayed readable, so the tests were live                         |
| wheel-shaped filesystem work (nested tree + 1 MiB)     | works  | content-verified on read-back                                            |

Two findings that change the implementation rather than the architecture:

- **The package's own `%TEMP%` is writable with no grant from us.** The probe's `icacls` step turned out to be
  unnecessary — Windows provisions a per-package `AC\Temp` and the container can write it. The broker does not
  have to provision scratch space.
- **`TEMP`/`TMP` set by the launcher do not survive into the child.** Windows overrides them at process init.
  Anything that steers the sandboxed process by environment variable — `HTTP_PROXY`, `PIP_INDEX_URL`,
  `SSL_CERT_FILE` — must be verified to survive rather than assumed, and the path-shaped variables Windows
  reserves per-package must be avoided entirely. **Still unmeasured:** whether ordinary (non-path) variables
  survive; the probe captures `OS_PROBE_MARK` and `HTTP_PROXY` for exactly this question, and that field of the
  report was not captured in the run above. If they do not survive, the shim must be pointed at the proxy by
  `pip.ini` or an explicit `--proxy` argument instead.

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

**Measured, on Windows 11 (10.0.26200), unelevated.** This document previously said nothing in it had been
executed and listed four questions for a Windows owner. All four now have answers, from
`windows-appcontainer-probe.ps1` in this directory.

| #   | Question                                                                   | Answer                                                                      |
| --- | -------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| 1   | `CreateAppContainerProfile` succeeds as a standard user, unelevated        | **yes**                                                                     |
| 2   | A container with no network capability genuinely cannot open a socket      | **confirmed for external and host-loopback; NOT for in-container loopback** |
| 3   | A named pipe ACL'd to the package SID is reachable from inside, unelevated | **yes**, and it carries sustained bidirectional traffic                     |
| 4   | Whether _any_ in-container loopback listener is possible                   | **yes — including across two processes in the same container**              |

Question 4 was the one that would most change the design, and it did: the socket-transparent model is
recoverable, so `pip` can work inside the sandbox on Windows after all. Question 2's answer needs stating
carefully rather than as a flat yes — the container reaches nothing outside itself, but loopback _within_ the
container is not filtered, and that distinction is the entire finding.

Still unmeasured, and the next thing a Windows owner should check:

1. **Whether ordinary environment variables survive into the container.** `TEMP`/`TMP` demonstrably do not.
   The probe carries `OS_PROBE_MARK` and `HTTP_PROXY` canaries for this; that field was not captured in the
   first run. It decides whether the shim can be pointed at the proxy by environment, as on Linux and macOS, or
   needs `pip.ini` / an explicit `--proxy`.
2. **Whether the broker can spawn the shim into an existing container** rather than both being launched
   together — the probe started two peers itself, which is not quite the production arrangement.
3. **Behaviour under a third-party endpoint agent.** This machine ran Windows Defender with MpsSvc healthy.
   AppContainer network isolation is a WFP policy; a product that displaces or augments those filters could
   change the denials, and a denial that is really a third-party filter is not the design working.

Two smaller findings already recorded above: the package's own `%TEMP%` needs no grant from us, and this
machine carried two pre-existing loopback exemptions belonging to other software — ours was not among them, so
the host-loopback denial is genuine rather than inherited configuration.

## Sources

- [CreateProcessInSandbox](https://learn.microsoft.com/en-us/windows/win32/secauthz/createprocessinsandbox)
- [AppContainer for legacy applications](https://learn.microsoft.com/en-us/windows/win32/secauthz/appcontainer-for-legacy-applications-)
- [CreateAppContainerProfile](https://learn.microsoft.com/en-us/windows/win32/api/userenv/nf-userenv-createappcontainerprofile)
- [microsoft/mxc — base process container](https://github.com/microsoft/mxc/blob/main/docs/base-process-container/guide.md)
- [MXC internals](https://www.originhq.com/research/mxc-execution-containers-internals)
- [anthropic-experimental/sandbox-runtime](https://github.com/anthropic-experimental/sandbox-runtime)
- [Tyranid's Lair — UWP localhost network isolation](https://www.tiraniddo.dev/2018/07/uwp-localhost-network-isolation-and-edge.html)
