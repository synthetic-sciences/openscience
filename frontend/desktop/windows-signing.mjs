/** @param {Record<string, string | undefined>} env */
export function windowsSigning(env) {
  if (env.OPENSCIENCE_DESKTOP_SIGNED !== "true") return { forceCodeSigning: false, signExecutable: false }

  const required = [
    "WINDOWS_SIGNING_ENDPOINT",
    "WINDOWS_SIGNING_ACCOUNT",
    "WINDOWS_SIGNING_PROFILE",
    "WINDOWS_SIGNING_PUBLISHER",
  ]
  const missing = required.filter((name) => !env[name]?.trim())
  if (missing.length) throw new Error(`Missing Windows signing configuration: ${missing.join(", ")}`)

  return {
    forceCodeSigning: true,
    signExecutable: true,
    signExts: [".dll", ".node"],
    azureSignOptions: {
      endpoint: env.WINDOWS_SIGNING_ENDPOINT,
      codeSigningAccountName: env.WINDOWS_SIGNING_ACCOUNT,
      certificateProfileName: env.WINDOWS_SIGNING_PROFILE,
      publisherName: env.WINDOWS_SIGNING_PUBLISHER,
      fileDigest: "SHA256",
      timestampDigest: "SHA256",
      timestampRfc3161: "http://timestamp.acs.microsoft.com",
    },
  }
}
