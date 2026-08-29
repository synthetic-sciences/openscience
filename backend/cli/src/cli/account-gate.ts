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
  // Internal, read-only OpenAPI generation used by the SDK and release build.
  // It reads local route metadata and must work in a clean CI home.
  "generate",
])

export function isScientificCapabilityCanary(command: string | undefined, argv: string[]): boolean {
  return command === "debug" && argv[1] === "capability-canary"
}

/** Commands that are safe and necessary before an account session exists. */
export function requiresOpenScienceAccount(command: string | undefined, argv: string[]): boolean {
  if (argv.some((value) => value === "--help" || value === "-h" || value === "--version" || value === "-v")) {
    return false
  }
  // The default command hosts the workspace, whose full-page account gate is
  // itself the primary first-run recovery path.
  if (!command) return false
  // Release canaries exercise only exact local/Modal capability runtimes. They
  // must work in an isolated candidate home without an Atlas account and do
  // not expose the general debug surface accountlessly.
  if (isScientificCapabilityCanary(command, argv)) return false
  return !RECOVERY_COMMANDS.has(command)
}

export const ACCOUNT_REQUIRED_MESSAGE =
  "A Synthetic Sciences account is required. Run `openscience login` once on this device."
