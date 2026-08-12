import { describe, expect, test } from "bun:test"
import { customCredentialIdentity } from "./custom-credential"

describe("custom credential identity", () => {
  test("maps a service and field to the runtime environment contract", () => {
    expect(customCredentialIdentity("My Research API", "Access_Token")).toEqual({
      ok: true,
      id: "custom:my-research-api",
      field: "access_token",
      label: "My Research API",
    })
  })

  test("rejects field names that would persist but never produce an environment variable", () => {
    for (const field of ["---", "api key", "1token", "token-name", "a".repeat(65)]) {
      expect(customCredentialIdentity("Service", field).ok).toBe(false)
    }
  })
})
