import { expect, test } from "bun:test"
import { windowsSigning } from "../../../../frontend/desktop/windows-signing.mjs"

const configured = {
  OPENSCIENCE_DESKTOP_SIGNED: "true",
  WINDOWS_SIGNING_ENDPOINT: "https://eus.codesigning.azure.net/",
  WINDOWS_SIGNING_ACCOUNT: "account",
  WINDOWS_SIGNING_PROFILE: "profile",
  WINDOWS_SIGNING_PUBLISHER: "Example Inc.",
}

test("local Windows packaging needs no signing account", () => {
  expect(windowsSigning({})).toEqual({ forceCodeSigning: false, signExecutable: false })
  expect(windowsSigning({ ...configured, OPENSCIENCE_DESKTOP_SIGNED: "false" })).toEqual({
    forceCodeSigning: false,
    signExecutable: false,
  })
})

test.each(Object.keys(configured).filter((name) => name !== "OPENSCIENCE_DESKTOP_SIGNED"))(
  "signed Windows packaging rejects missing or blank %s",
  (name) => {
    for (const value of [undefined, "", "   "]) {
      expect(() => windowsSigning({ ...configured, [name]: value })).toThrow(name)
    }
  },
)

test("production Windows packaging selects the configured Azure identity and timestamps", () => {
  const options = windowsSigning(configured)
  expect(options.forceCodeSigning).toBe(true)
  expect(options.signExecutable).toBe(true)
  expect(options.azureSignOptions).toMatchObject({
    endpoint: configured.WINDOWS_SIGNING_ENDPOINT,
    codeSigningAccountName: configured.WINDOWS_SIGNING_ACCOUNT,
    certificateProfileName: configured.WINDOWS_SIGNING_PROFILE,
    publisherName: configured.WINDOWS_SIGNING_PUBLISHER,
    fileDigest: "SHA256",
    timestampDigest: "SHA256",
    timestampRfc3161: "http://timestamp.acs.microsoft.com",
  })
})
