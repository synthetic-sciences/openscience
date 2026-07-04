#!/usr/bin/env node

// Best-effort guard for GLOBAL installs only: the deprecated @synsci/cli
// package links the same `openscience` bin, and npm refuses to overwrite a
// bin file owned by another package (EEXIST) — which dead-ends upgrades.
// Remove the stale package before ours is linked.
//
// This must NEVER fail the install: npm policies that block nested npm calls
// (or script execution entirely) make this best-effort. The `npx synsci`
// launcher and the openscience.sh/install script handle the conflict
// deterministically.

import { execSync } from "child_process"

try {
  if (process.env.npm_config_global === "true" || process.env.npm_config_global === "1") {
    execSync("npm rm -g @synsci/cli", { stdio: "ignore", timeout: 60000 })
  }
} catch {
  // swallow everything — the install must proceed
}
process.exit(0)
