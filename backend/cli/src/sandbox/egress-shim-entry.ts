/**
 * Minimal, dependency-light entry point for the sandboxed loopback shim. In
 * development `Sandbox.shimPlan()` bundles this file and execs `bun` against
 * the bundle — never against `src/index.ts` — because `src/index.ts`'s graph
 * pulls in `Global` (an unguarded top-level `await Bun.file(...).write(...)`
 * at `src/global/index.ts` — `EROFS` under a read-only source tree) and
 * `ModelsDev` (a live fetch at module-eval time). Both run before any argv
 * check could skip them and would kill the shim under exactly the
 * read-only/no-network conditions this mechanism exists to survive. This
 * file imports only `./egress` (nothing but a Bun type) and the marker
 * constant below (a single string, no other exports), so evaluating it does
 * no I/O beyond the two lines that matter.
 *
 * `shimPlan()` does not exec this file: it runs `bun build` over it and execs
 * the resulting self-contained bundle, because only the bundle's own path has
 * to be visible inside the sandbox, where `--tmpfs /tmp` masks whatever it
 * covers. So an added import does not have to live anywhere in particular —
 * a sibling module and an npm package are equally fine, and the npm case is
 * specifically what a package-root bind got wrong before (in this bun
 * workspace `node_modules/<pkg>` is a symlink into the monorepo-root store,
 * above the package root: the link was bound, its target was not).
 *
 * Four things are still not safe to add here, and none of them are about
 * where files live. Import-time side effects (a top-level fetch, a top-level
 * write) run in the bundle exactly as they would in the source, and would
 * reintroduce the failure this file exists to avoid — the shim dies under the
 * read-only, no-network conditions it is supposed to survive, with its output
 * on /dev/null. Resolving anything from `import.meta.dir`/`url` points at
 * `Global.Path.bin`, where the bundle runs, not at this directory. A runtime
 * `import(expression)` cannot be inlined by the bundler, so it would resolve
 * against a path nothing bound (a literal `import("./x")` is inlined and
 * fine). And a dependency that loads a native binding bundles cleanly but
 * still `dlopen`s a `.so` at run time, from a path nothing bound and nothing
 * checks — see `shimPlan`'s residual list for the measurement.
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
import { SHIM_READY_MARKER } from "./egress-shim-marker"

const [port, socket] = process.argv.slice(-2)
Egress.serveShim({ port: Number(port), socket: socket! })
await Bun.write(SHIM_READY_MARKER, "").catch(() => {})
await new Promise(() => {})
