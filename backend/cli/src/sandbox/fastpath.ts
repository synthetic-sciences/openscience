/**
 * The three ways the binary re-enters itself for the sandbox, handled before
 * anything else in the process exists.
 *
 * These used to sit at the top of `src/index.ts`, guarded by a comment saying
 * they ran "before any other CLI machinery is reached". They did not. ESM
 * hoists and evaluates every static import before the first statement of the
 * importing module, so `import { OpenScience } from "./openscience"` and its
 * neighbours had already pulled in `project/bootstrap` -> `plugin` -> `server`
 * -> `global`, and `global` creates the user's data, config, state, log and bin
 * directories in a top-level await.
 *
 * Inside an AppContainer none of those paths is reachable, so the egress SHIM —
 * which is this binary, re-entered in the container — died during module
 * evaluation, before a single line of its own code ran:
 *
 *     EEXIST: file already exists, mkdir 'C:\Users\<user>\.local\state\openscience'
 *         at async <anonymous> (src/global/index.ts:105:15)
 *         at async <anonymous> (src/server/server.ts:43:1)
 *         at async <anonymous> (src/plugin/index.ts:12:1)
 *         at async <anonymous> (src/project/bootstrap.ts:23:1)
 *
 * That is why the proxy inside the container was a dead port and DNS failed
 * there: the thing serving it was never alive. A comment cannot enforce import
 * order — a module can, so the checks live here and this is imported first.
 *
 * Everything reachable from here is loaded with `await import()` for the same
 * reason. Keep it that way.
 */

// The egress shim: opens a listener inside the sandbox and forwards bytes to
// the host's proxy. It must never touch the log file (the namespace bubblewrap
// builds is read-only — EROFS) or the network (unshared but for one socket, so
// a refresh check hangs). It also never returns: the hanging await below is
// what stops the rest of the import graph from evaluating behind it.
if (process.argv[2] === "__egress-shim") {
  const { Egress } = await import("./egress")
  const { SHIM_READY_MARKER } = await import("./egress-shim-marker")
  Egress.serveShim({ port: Number(process.argv[3]), socket: process.argv[4] as string })
  await Bun.write(SHIM_READY_MARKER, "").catch(() => {})
  await new Promise(() => {})
}

// Windows containment is applied AT process creation rather than by a wrapper
// executable, so the binary launches itself into the AppContainer and execs the
// real command there.
//
// The shim has to run INSIDE the container and never exits on its own, while
// `AppContainer.launch` blocks on WaitForSingleObject. bun:ffi cannot move that
// wait off the event loop, so the shim gets a helper process whose only job is
// to hold it.
if (process.argv[2] === "__appcontainer-detached") {
  const { AppContainer } = await import("./appcontainer")
  const sid = process.argv[3] as string
  const capabilities = JSON.parse(process.argv[4] as string) as string[]
  // Empty means "inherit", which is only ever right when the caller knows the
  // container can reach wherever this process happens to have started.
  const cwd = process.argv[5] || undefined
  const code = await Promise.resolve(
    AppContainer.launch(sid, process.argv.slice(6), capabilities, undefined, cwd),
  ).catch((error: Error) => {
    process.stderr.write(`openscience: ${error.message}\n`)
    return 1
  })
  process.exit(code)
}

if (process.argv[2] === "__appcontainer-launch") {
  const rest = process.argv.slice(3)
  const split = rest.indexOf("--")
  // Argv is checked before the import, so a malformed invocation answers the
  // same way everywhere. `appcontainer` opens Windows system libraries.
  if (split === -1) {
    process.stderr.write("openscience: __appcontainer-launch requires <spec> -- <command>\n")
    process.exit(2)
  }
  const { AppContainer } = await import("./appcontainer")
  const code = await AppContainer.main(rest[0] as string, rest.slice(split + 1)).catch((error: Error) => {
    process.stderr.write(`openscience: ${error.message}\n`)
    return 1
  })
  process.exit(code)
}

export {}
