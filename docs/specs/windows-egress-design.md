# Windows allowlist egress — design

## Status

Windows confinement is **done and verified in CI**: the kernel reports
`TokenIsAppContainer=1`, writes inside the workspace succeed, writes outside are
blocked. What remains before Windows meets the merge gate — _a governed
`pip install` under `network: "allowlist"`_ — is egress, which does not exist at
all today. `EgressRuntime.start()` is `platform === "darwin" ? seatbelt : bubblewrap`;
`spec.pipe` is carried through the spec and nothing serves it.

This is feature work, not debugging. Everything below is grounded in
`probe-report.json`, measured on a real Windows 11 machine, unelevated.

### Capabilities are proven, as of the run below

`network: "allow"` grants `internetClient` and `privateNetworkClientServer`
through a hand-marshalled `SID_AND_ATTRIBUTES` array, and until now only the
spec composition was tested — the kernel path had never run anywhere. Measured
on the target machine:

```
✓ pass  write inside the workspace succeeds
✓ pass  the child actually runs inside the AppContainer (TokenIsAppContainer=1)
✓ pass  write outside the workspace is blocked
✓ pass  network egress blocked in deny mode
```

That last line passes only if three things held in order: the HOST reached
example.com, the sandbox reached it under `allow`, and the sandbox was refused
under `deny`. So the marshalling is correct and `deny` genuinely severs the
network — the two halves that a silent no-op would have made indistinguishable.

What remains unproven is therefore narrower than it was: the broker's overlapped
I/O, the shim, pipe concurrency, and the `HTTP_PROXY` chain end to end. `allow`
and `deny` are done on Windows; only `allowlist` needs building.

## What was measured

From `docs/specs/windows-appcontainer-probe.ps1`, run on the target machine:

| Property                                            | Result                                                 | Consequence                                                         |
| --------------------------------------------------- | ------------------------------------------------------ | ------------------------------------------------------------------- |
| Direct outbound to `1.1.1.1:443`                    | **AccessDenied (WSA 10013)**                           | zero capabilities really does mean no network                       |
| DNS resolution                                      | `HostNotFound`                                         | the container cannot resolve, so the broker must                    |
| Reach a listener on the **host's** loopback         | **Timeout**                                            | a host-side proxy is unreachable — a shim is required, not a nicety |
| Named pipe with the **default** DACL                | **Access denied**                                      | the boundary holds by default                                       |
| Named pipe with a DACL granting the **package SID** | **connected, 65540 bytes**                             | this is the only usable transport across the boundary               |
| Sustained pipe throughput                           | 65536 sent / 65536 received                            | enough for wheel downloads                                          |
| Loopback **inside** the container, two processes    | listener accepted `127.0.0.1:52952`, echoed 8192 bytes | a shim in the same container is reachable by the payload            |
| `HTTP_PROXY` env into the container                 | survived as `http://127.0.0.1:9/`                      | proxy steering needs no shim script, unlike bubblewrap              |
| Write to the user profile                           | Access denied                                          | containment confirmed independently                                 |
| The container's own `%TEMP%`                        | `…\Packages\<profile>\AC\Temp`, writable with no grant | free scratch space                                                  |

Two facts decide the architecture: **the container cannot reach the host's
loopback**, and **a pipe whose DACL names the package SID is fully usable**. So
the proxy cannot simply listen on `127.0.0.1` the way macOS does.

### And isolation runs both ways

Measured afterwards on a Windows CI runner, because the probe had only tested one
direction and the answer would have removed the pipe entirely if it went the
other way:

```
child bound 127.0.0.1:50496
===> host -> container listener: REFUSED (Failed to connect)
```

The host cannot connect IN to a listener the container binds either. Plain TCP
in either direction is out, so the named pipe is confirmed necessary rather than
merely assumed. `test/sandbox/appcontainer-transport.test.ts` now asserts this,
so if a Windows update ever relaxes it the transport can be simplified and we
find out loudly.

### The base interpreter must be one the user owns

Measured on the target machine, after the first end-to-end run failed:

```
icacls C:\Python312 | findstr /i "APPLICATION PACKAGES"   -> (nothing)

C:\Python312  NT AUTHORITY\SYSTEM:(OI)(CI)(F)
              BUILTIN\Administrators:(OI)(CI)(F)
              BUILTIN\Users:(OI)(CI)(RX)
```

Both halves of the problem, confirmed: no `ALL APPLICATION PACKAGES` ACE, so the
container cannot read it — and the user holds only `RX`, no ownership and no
`WRITE_DAC`, so the user can never add one. `icacls` returned "Access is denied",
and the run then failed several layers downstream as `No Python at '...'` with
child exit 103.

This is not a gap in the grant. **A venv is not a Python.** It holds a redirector,
an empty `site-packages` and a `pyvenv.cfg` naming `home`; the interpreter binary,
`python3xx.dll` and the whole standard library stay in the base installation. So
every venv depends on its base at runtime, on every platform.

Linux and macOS never notice because both allow the read for free — and note that
main tightened exactly this and still does: it replaced `--ro-bind / /` with an
explicit allowlist whose `linuxRuntimeMounts()` binds `/usr` wholesale, which is
where a system Python lives. That solves _enumeration_. Windows adds a second
problem on top:

|                                    | Linux                                    | Windows                      |
| ---------------------------------- | ---------------------------------------- | ---------------------------- |
| Which paths does the program need? | solved by enumerating runtime roots      | same answer: the base Python |
| **May we grant them?**             | always — a bind mount needs no ownership | **only if you own the path** |

`bwrap --ro-bind /usr /usr` builds a view of the filesystem for a namespace we
control. `icacls /grant` **modifies the real ACL of a shared system directory**.
No amount of naming the right paths gets past that.

So on Windows the base interpreter has to live under the user's profile: a
per-user python.org install, or one uv provisions. Selection prefers a grantable
interpreter for that reason, and falls back to an ungrantable one rather than
refusing — an unsandboxed run works fine with a machine-wide Python.

## Architecture

The probe's own header names it, and every hop above is measured:

```
pip --(loopback, inside container)--> shim --(named pipe, granted DACL)--> broker --> network
```

Three pieces, two of them new:

1. **Broker** (host, new). A named-pipe server whose DACL grants exactly this
   run's package SID. It bridges pipe traffic into the existing
   `Egress.serveProxy`, so host allowlisting, `Proxy-Authorization`, and the
   audit trail are unchanged and shared with Linux/macOS.
2. **Shim** (inside the container, new). Our own binary re-entered a second time
   in the same AppContainer, listening on an ephemeral loopback port and
   forwarding to the pipe. Same pattern as `__egress-shim`, and the fourth
   argv-triggered entry point after `__egress-shim` and `__appcontainer-launch`.
3. **Steering** (existing). `HTTP_PROXY`/`HTTPS_PROXY` point the payload at the
   shim's port. Measured to survive into the container, so nothing needs to be
   smuggled through a shell script the way bubblewrap requires.

The shim binds an **ephemeral** port and reports it to the launcher on stdout;
the launcher then sets `HTTP_PROXY` for the payload. A fixed port (as
`SHIM_PORT` does for bubblewrap) is wrong here: an AppContainer shares the host's
network stack rather than getting a namespace, so a fixed port can collide with
whatever else is on the machine.

## Two decisions, with recommendations

### `network: "allow"` — grant the capabilities, and document the one real gap

Today `allow` on Windows silently behaves as `deny`: the container holds zero
capabilities, so no mode has network. That is a false claim about a security
property and cannot stay.

An earlier draft of this document proposed routing `allow` through the same
broker with filtering off. **That was wrong**, and for the same reason it keeps
being wrong: it restricts `allow` to HTTP/HTTPS by _our_ choice while calling it
unrestricted. `allow` should mean what it means on the other two platforms.

Grant the capabilities instead:

|                           | macOS `allow` | Windows with capabilities             |
| ------------------------- | ------------- | ------------------------------------- |
| Internet, any protocol    | yes           | yes — `internetClient`                |
| LAN / local subnet        | yes           | yes — `privateNetworkClientServer`    |
| **localhost (127.0.0.1)** | yes           | **no — blocked by network isolation** |

`internetClient` permits communication with services on the Internet but not the
local subnet or loopback; `privateNetworkClientServer` covers the subnet. Neither
covers loopback: AppContainer loopback is blocked at the firewall layer
regardless of capability, and the only exemption is
`CheckNetIsolation.exe LoopbackExempt`, which requires admin. Admin is out of
scope for this product by an explicit product decision, so this gap is permanent
rather than pending.

That gap is not cosmetic for a science tool. A local Ollama on `127.0.0.1:11434`,
a local Jupyter, a local database or model server are all unreachable from a
sandboxed process on Windows under any policy. It must be stated at the
interface, not discovered — a user who sets `allow` and cannot reach their own
localhost service deserves to be told why, once, rather than debug it.

`allow` runs **both** mechanisms: the capabilities above, and the broker + shim
with host filtering switched off. Not because it needs the broker for security —
it does not — but because without it the modes invert, and a knob where
_loosening_ the policy _removes_ a capability is a design smell no user would
predict. Anyone tightening `allow` to `allowlist` to be safer would be surprised
to gain localhost access.

The inversion exists only here. On the other two platforms `allow` applies no
network restriction at all:

```
bubblewrap:  if (policy.network !== "allow") args.push("--unshare-net")
seatbelt:    if (policy.network !== "allow") lines.push("(deny network*)")
```

so `allow` already reaches loopback and is already a superset. Windows should
match that ordering rather than invent its own.

With both mechanisms running:

| `allow` on Windows          | route                                 | works  |
| --------------------------- | ------------------------------------- | ------ |
| HTTP/HTTPS to the internet  | broker                                | yes    |
| HTTP/HTTPS to **localhost** | broker — a host process, unrestricted | yes    |
| raw TCP/UDP to the internet | capability, direct                    | yes    |
| raw TCP/UDP to localhost    | —                                     | **no** |

### Broker failure means opposite things in the two modes

This falls out of the above and is worth stating explicitly, because failing
open is normally the wrong instinct:

- **`allowlist`** — the broker IS the enforcement point. Failure is **fatal**;
  the command must not run. Fail closed.
- **`allow`** — the broker is a convenience. Failure **falls back to direct**,
  which is exactly the connectivity the user asked for. Nothing is bypassed,
  because nothing was being enforced.

### What is left blocked, and for whom

The residual gap after this is narrow but real: **a pre-existing host service
speaking a non-HTTP protocol.** The probe measured that loopback _inside_ the
container works — two processes, 8192 bytes echoed, `acceptedFrom
127.0.0.1:52952` — so anything the sandboxed process starts itself is fine:

- `torch.distributed` / DDP rendezvous on `tcp://127.0.0.1:29500` — same container
- `multiprocessing`, joblib, any spawned workers — same container
- a Ray or Dask cluster the agent starts — same container
- DuckDB, SQLite, in-process work — no network at all

That covers most raw-TCP-on-localhost in ML work, because multi-GPU training and
local parallelism are same-container by construction. What remains blocked:

1. **Databases** — Postgres 5432, Redis 6379, Mongo 27017, Neo4j Bolt 7687.
   "Analyse the data in my local Postgres" is an ordinary request and would fail.
2. **Docker Desktop port mappings** — acute on Windows specifically, since Docker
   Desktop is how people run local services there.
3. **gRPC inference servers** — Triton, some vLLM setups; gRPC clients often
   ignore `HTTP_PROXY`, so the broker does not rescue them.

Everything HTTP — Ollama, vLLM's OpenAI endpoint, llama.cpp, MLflow, TensorBoard,
Elasticsearch, MinIO — is covered by the broker.

**Recorded, not built:** the broker already crosses the boundary, so it could
forward a _declared_ raw port as well as proxy HTTP. `sandbox.allowLocalPorts:
[5432]` would sit beside the existing `allowHosts` and `allowWrite` vocabulary
and close this completely, explicitly rather than ambiently — the right default
for anything reaching out of a sandbox. Left until someone actually hits it.

### How the gap is reported — the existing channel, not a doc line

Documentation is where limitations go to die; the user would meet this as
`connection refused` and nothing else, which is the shape of every expensive bug
in this feature. It rides `decide()`'s existing one-time `warning`, already wired
into `tool/bash.ts`, `tool/notebook.ts` and `compute/jobs.ts` for "sandbox
requested but unavailable" — the same species of problem, _you asked for X and
the platform gives you less_. A second mechanism for it is how two commands end
up disagreeing about one state, which this backend has already done once.

**The wording must narrow when the broker lands.** Today there is no broker, so
`allow` genuinely cannot reach localhost at all and the shipped message says so.
Once `allow` is a superset the true claim becomes _"non-HTTP connections to
127.0.0.1 are unavailable"_ — a warning that overstates a limitation is the same
defect as one that understates it.

### Broker lifetime — per process, matching `EgressRuntime` today

`EgressRuntime` already keeps one proxy per process in `state.running`. The
Windows broker should match: one pipe per openscience process, with a random
unguessable name, whose DACL grants only that run's package SID. A per-machine
broker would be a shared, long-lived attack surface reachable by every
AppContainer that ever learns the name — and the probe measured that a pipe is
openable by exactly whoever the DACL names.

## Security properties this must preserve

- The pipe DACL is the boundary. It names one package SID and nothing else; the
  probe measured that a default DACL denies the container outright, so the grant
  is the whole of the access decision. This deserves the same scrutiny as the
  seatbelt profile text.
- The shim runs **inside** the container, so it is as confined as the payload. It
  must not be handed capabilities, and it must not be the path by which anything
  else becomes reachable.
- Host allowlisting stays in `Egress.serveProxy` — shared with the other two
  platforms, so a policy fix lands everywhere at once.
- `network: "deny"` must keep starting **no** broker and **no** shim. Deny is
  currently correct on Windows by construction, and it must stay correct by
  construction rather than by configuration.
- Capabilities are granted ONLY for `allow`. `allowlist` must keep zero
  capabilities: the broker is the enforcement point, and a container that can
  reach the internet directly would route around it entirely while still
  reporting that a policy was applied.

## Sources

- [Communicating with localhost](https://learn.microsoft.com/en-us/windows/iot-core/develop-your-app/loopback) — loopback is restricted by network isolation; `CheckNetIsolation LoopbackExempt` is the only exemption
- [Understanding Network Access in Windows AppContainers](https://projectzero.google/2021/08/understanding-network-access-windows-app.html) — how the capability checks are enforced
- [Troubleshooting UWP firewall](https://learn.microsoft.com/en-us/windows/security/operating-system-security/network-security/windows-firewall/troubleshooting-uwp-firewall) — the `AppContainerLoopback` filter that drops the packets

## Verification

`Sandbox (windows-latest)` already runs a live self-test on a real kernel. It
extends naturally:

- the deny-mode network assertion stops being vacuous once a broker exists — it
  currently reports that honestly and skips
- an allowlist test that reaches an allowed host and is refused a disallowed one,
  mirroring `egress-live.test.ts` (bubblewrap) and `egress-live-seatbelt.test.ts`
- widen the Windows job from `appcontainer-live.test.ts` to `test/package/` once
  the broker lands — that is the merge gate itself, and until then it would be
  red for a feature that was never built

## Open questions

- Does a pipe survive the payload's process tree being killed mid-transfer, and
  does the broker notice? `killTree` on Windows uses `taskkill /t`.
- Concurrency: the probe used a single-instance pipe. Wheel downloads are
  parallel, so the server needs an instance per connection, and there is a
  recorded follow-up about uncapped proxy concurrency on the other platforms.
- Does the shim need its own `%TEMP%`? The container's `AC\Temp` is writable with
  no grant, which is probably enough.
