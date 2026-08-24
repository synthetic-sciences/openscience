const RECOVERY_COMMANDS = new Set([
  "login",
  "logout",
  "status",
  "whoami",
  "init",
  "onboard",
  "doctor",
  "local",
  "upgrade",
  "uninstall",
  "completion",
  "web",
  "serve",
])

/** Commands needed to authenticate, inspect, repair, or host the sign-in UI. */
export function requiresOpenScienceAccount(command: string | undefined, argv: string[]): boolean {
  if (argv.some((value) => value === "--help" || value === "-h" || value === "--version" || value === "-v")) {
    return false
  }
  // The default command hosts the workspace, whose full-page account gate is
  // itself the primary first-run recovery path.
  if (!command) return false
  return !RECOVERY_COMMANDS.has(command)
}

export const ACCOUNT_REQUIRED_MESSAGE =
  "A Synthetic Sciences account is required. Run `openscience login` once on this device."
