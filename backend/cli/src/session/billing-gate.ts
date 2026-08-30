/** Compatibility exports for the managed inference billing boundary. */
export {
  accessRoute as telemetryRoute,
  isCodexOAuthProvider,
  requiresWalletBalance,
  resolveAccessRoute as resolveTelemetryRoute,
  resolveCredentialSource,
  type AccessRoute as TelemetryRoute,
  type CredentialSource,
} from "./access-route"

export function shouldReportUsage(): boolean {
  // Atlas proxy settlement is authoritative; the retired usage endpoint is not.
  return false
}
