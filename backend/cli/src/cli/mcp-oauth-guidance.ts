export interface OAuthCliEnvironment {
  env?: Record<string, string | undefined>
  platform?: NodeJS.Platform
  stdoutIsTTY?: boolean
}

export function isSshSession(env: Record<string, string | undefined> = process.env): boolean {
  return Boolean(env.SSH_CONNECTION || env.SSH_CLIENT || env.SSH_TTY)
}

/** Browser opening is deliberately skipped when the CLI can tell that its
 * browser would be absent or would run on the wrong side of an SSH session. */
export function needsManualOAuthBrowser(input: OAuthCliEnvironment = {}): boolean {
  const env = input.env ?? process.env
  const platform = input.platform ?? process.platform
  const stdoutIsTTY = input.stdoutIsTTY ?? process.stdout.isTTY
  if (isSshSession(env)) return true
  if (env.CI) return true
  if (stdoutIsTTY !== true) return true
  return platform === "linux" && !env.DISPLAY && !env.WAYLAND_DISPLAY
}

export function manualOAuthGuidance(input: {
  authorizationUrl: string
  callbackPort: number
  env?: Record<string, string | undefined>
}): string[] {
  const env = input.env ?? process.env
  if (isSshSession(env)) {
    return [
      "Open a new terminal on your local computer and forward the OAuth callback port:",
      `ssh -L ${input.callbackPort}:127.0.0.1:${input.callbackPort} <your-ssh-destination>`,
      "Keep that SSH session open, then open this authorization URL in your local browser:",
      input.authorizationUrl,
    ]
  }
  return [
    "Open this authorization URL in a browser on the machine running OpenScience:",
    input.authorizationUrl,
    `The provider will return to 127.0.0.1:${input.callbackPort}; keep this command running until it completes.`,
  ]
}
