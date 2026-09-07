const updateSwap = "--desktop-update-swap"

// Keep the signed updater exchange independent of normal CLI initialization.
// In particular, do not preload account/provider configuration or import the
// command graph before the already-verified application slots are exchanged.
if (process.argv[2] === updateSwap) {
  try {
    const { DarwinUpdateSwap } = await import("./process/darwin-update-swap")
    process.exit(await DarwinUpdateSwap.run(process.argv[3] ?? ""))
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  }
}

// Worker environments intentionally omit application configuration. Dispatch
// the ownership supervisor before the command graph can initialize a different
// data root or migrate the user's default storage in that reduced environment.
if (process.argv[2] === "__openscience_darwin_responsibility_launcher__") {
  try {
    const { DarwinResponsibilityLauncher } = await import("./process/darwin-responsibility-launcher")
    process.exit(await DarwinResponsibilityLauncher.run(process.argv.slice(3)))
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  }
}

// Desktop sidecars establish their exact parent/death receipt before loading
// provider configuration or the command graph. A hard-killed desktop can then
// never strand a half-initialized runtime that blocks update rollback.
if (process.env.OPENSCIENCE_DESKTOP_PARENT_PID || process.env.OPENSCIENCE_DESKTOP_PARENT_TOKEN) {
  const { DesktopParent } = await import("./process/desktop-parent")
  DesktopParent.launch()
}

await import("./index")
