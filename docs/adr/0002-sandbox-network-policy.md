# ADR 0002: Sandbox network policy becomes three-state, allowlist by default

Status: accepted

## Context

`sandbox.network` is `"allow" | "deny"`. Deny locks kernels out of PyPI, NCBI, UniProt, PDB and
EBI, which is most of what a research tool is for. Allow is unrestricted egress. Neither state is
what the product needs: a kernel that cannot reach a package index or a sequence database cannot
do the work it exists to do, and a kernel with unrestricted egress can send agent-controlled data
anywhere on the internet. Because the installer needed the egress the kernel was denied, earlier
design work gave it a second, network-enabled sandbox purely so it could have that egress the
kernel could not.

## Decision

`sandbox.network` becomes three-state: `"deny" | "allowlist" | "allow"`, defaulting to
`"allowlist"`.

Enforcement is `--unshare-net` plus a bind-mounted unix socket, established by two measurements
taken on the spike branch `proto/sandbox-allowlist-proxy` before the proxy itself was written:
inside `bwrap --unshare-net`, TCP to any host — including the host's own loopback — returns `000`,
and a unix socket bind-mounted into that same network namespace still crosses it. The socket is
therefore the only route out of the namespace. The proxy on the host end of that socket resolves
names itself, which is why the sandboxed process has no DNS of its own.

One policy covers kernel and installer. There is no separate network-enabled install sandbox:
under `"allowlist"` the installer reaches the same allowlisted hosts through the same proxy the
kernel uses, so the asymmetry that motivated a second sandbox no longer exists.

Proxy policy is not part of the `ExecutionAuthority.generation` hash. `generation` hashes trust,
filesystem grants, and sandbox policy, and changing it tears down and reboots every live kernel
bound to it. Editing the allowlist is not that kind of change: it takes effect on the next
connection through the running proxy, without tearing down live kernels.

This ADR decides the default allowlist ships in code; per-project additions live in config.

## Consequences

This is a breaking change to a documented config key. Existing `"deny"` and `"allow"` values keep
working unchanged; only the default moves, from `"deny"` to `"allowlist"`.

`HTTP_PROXY`, `HTTPS_PROXY` and `NO_PROXY` join `SAFE_ENV_PREFIXES` so they reach a kernel
process, and `Sandbox.wrapArgv` must compose a shim into the sandboxed argv, because pip,
requests and curl take an `http://host:port` proxy from those variables and none of them speak
unix sockets directly. Some process also has to start and stop the proxy across the CLI's own
lifecycle; this ADR does not fix that shape here, only that it is needed.

The boundary is host-level, not content-level. The proxy pipes bytes after checking the
authority; it cannot see inside TLS, so an allowlisted host can still be sent anything a client
sends it. Allowlisting bounds where a kernel can talk, not what it says once it is talking.

Unresolved: seatbelt has no namespace, so the _mechanism_ above — sever the network device, cross
back in only through a bind-mounted socket — does not transfer as written. That is not the same as
saying macOS cannot reach the same bounded-egress outcome: seatbelt can restrict
`network-outbound` to a specific local port via `(allow network-outbound (remote tcp
"localhost:PORT"))`, which is exactly the shape `anthropic-experimental/sandbox-runtime` ships (a
default network deny, then a selective allow for `network-bind`/`network-inbound`/
`network-outbound` on the proxy's loopback port). Neither OS can filter by hostname at the
sandbox-profile level — that is what the proxy is for on Linux too — so this is achievable via a
different mechanism, not impossible. Task 7 built it: the host-side proxy listens on a loopback
TCP port directly on macOS (no bind-mounted socket, no bridge — seatbelt has no namespace to put
either behind), the profile permits `network-bind`/`network-inbound`/`network-outbound` on
exactly that port as described above, and — because a loopback port, unlike a unix socket, carries
no filesystem permissions of its own — every request to it must additionally carry a
`Proxy-Authorization` secret generated fresh per proxy start. This is unverified in the same sense
the rest of this ADR's Linux side was before it was measured: nobody on this project has run
`sandbox-exec`, so whether the profile text above is actually _accepted and enforced_ as written —
including whether `network-bind`/`network-inbound` are the right operations to permit at all, and
whether `(local ...)` is the right filter for them — is a real, open question, not merely
theoretical caution. See `.superpowers/sdd/2026-08-09-sandbox-network-policy/task-7-report.md` for
exactly what a Mac owner still needs to run to close it. Windows has no sandbox backend at all, so
the question does not apply there.
