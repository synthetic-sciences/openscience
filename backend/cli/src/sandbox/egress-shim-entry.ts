/**
 * Minimal, dependency-light entry point for the sandboxed loopback shim. In
 * development `Sandbox.shimPlan()` execs `bun` against this file directly
 * — never against `src/index.ts` — because `src/index.ts`'s import graph
 * pulls in `Global` (an unguarded top-level `await Bun.file(...).write(...)`
 * at `src/global/index.ts` — `EROFS` under a read-only source tree) and
 * `ModelsDev` (a live fetch at module-eval time). Both run before any argv
 * check could skip them and would kill the shim under exactly the
 * read-only/no-network conditions this mechanism exists to survive. This
 * file imports only `./egress`, which itself imports nothing but a Bun type,
 * so evaluating it does no I/O beyond the two lines below.
 *
 * A compiled release has no separate entry to redirect to — `bun --compile`
 * embeds a single one — so it still goes through `index.ts`'s
 * `__egress-shim` argv check and therefore still evaluates that full graph.
 * See `sandbox.ts`'s `shimPlan` doc comment and the Task 4 report for what
 * that leaves reachable in a compiled binary.
 *
 * `Sandbox.shimScript` composes one call shape for both modes —
 * `<binary> __egress-shim <port> <socket>` — because the compiled path needs
 * the "__egress-shim" token to dispatch inside `index.ts`'s single-entry
 * argv check. This file has no dispatching to do, so it ignores that token
 * and reads port/socket positionally from the end instead of assuming a
 * fixed prefix, which also means it still works if `shimScript` ever calls
 * it without the token.
 */
import { Egress } from "./egress"

const [port, socket] = process.argv.slice(-2)
Egress.serveShim({ port: Number(port), socket: socket! })
// Signals Sandbox.shimScript's readiness wait — keep this literal in sync
// with sandbox.ts's SHIM_READY_MARKER.
await Bun.write("/tmp/.openscience-egress-shim.ready", "").catch(() => {})
await new Promise(() => {})
