import { expect, test, afterEach } from "bun:test"
import fs from "node:fs/promises"
import { CredentialProcessLedger } from "../../src/credentials/process-ledger"

// This ledger drives the revocation that must kill credential-bearing child
// processes, so a truncated or hand-edited file has to reach the operator as
// this ledger's own diagnostic. Parsing it unguarded threw a bare SyntaxError
// instead, and every retry failed identically with nothing actionable.
const ledger = CredentialProcessLedger.pathForTests()

afterEach(async () => {
  await fs.writeFile(ledger, "[]", "utf8").catch(() => undefined)
})

test("a truncated credential process ledger reports the corrupt ledger diagnostic", async () => {
  await fs.writeFile(ledger, '[{"id":"truncated"', "utf8")

  await expect(CredentialProcessLedger.revoke()).rejects.toThrow(
    `Credential process ledger ${ledger} is corrupt; refusing unsafe process revocation`,
  )
})

test("a structurally invalid credential process ledger reports the corrupt ledger diagnostic", async () => {
  await fs.writeFile(ledger, '[{"id":"missing-everything-else"}]', "utf8")

  await expect(CredentialProcessLedger.revoke()).rejects.toThrow(
    `Credential process ledger ${ledger} is corrupt; refusing unsafe process revocation`,
  )
})

test("a valid empty ledger still revokes cleanly", async () => {
  await fs.writeFile(ledger, "[]", "utf8")

  expect(await CredentialProcessLedger.revoke()).toBe(0)
})
