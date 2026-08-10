/**
 * Readiness marker `Sandbox.shimScript`'s composed wait loop polls for, and
 * the `__egress-shim` handler (`index.ts`, `egress-shim-entry.ts`) touches
 * once `Egress.serveShim`'s listener is bound.
 *
 * A single exported constant, not three independently hardcoded copies of
 * the same string: the three call sites drifting apart is a silent 3s stall
 * on every sandboxed command, not a loud failure, so nothing would catch it
 * happening. This file has no other exports and does nothing at import
 * time, so importing it (including from `egress-shim-entry.ts`, which must
 * stay dependency-light) costs nothing.
 *
 * Lives under `/tmp` deliberately: `bubblewrapArgs` always mounts `/tmp` as
 * a fresh, process-private tmpfs, so a fixed name here can't collide across
 * sandboxed processes or persist from a previous run.
 */
export const SHIM_READY_MARKER = "/tmp/.openscience-egress-shim.ready"
