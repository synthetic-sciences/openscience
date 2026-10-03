import { expect, test, afterEach } from "bun:test"
import fs from "node:fs/promises"
import { AuthorityProcessLedger } from "../../src/project/authority-process"

// The ledger is durable operator-visible state. A truncated or hand-edited file
// must surface as the ledger's own "corrupt; refusing unsafe process
// revocation" diagnostic. Parsing it unguarded instead threw a bare SyntaxError
// from revoke(), complete() and assertRelocationSafe(), naming neither the file
// nor the fact that revocation was refused.
const ledger = AuthorityProcessLedger.pathForTests()

afterEach(async () => {
  await fs.writeFile(ledger, "[]", "utf8").catch(() => undefined)
})

test("a truncated authority process ledger reports the corrupt ledger diagnostic", async () => {
  await fs.writeFile(ledger, '[{"id":"truncated"', "utf8")

  await expect(AuthorityProcessLedger.revoke()).rejects.toThrow(
    `Authority process ledger ${ledger} is corrupt; refusing unsafe process revocation`,
  )
})

test("a structurally invalid authority process ledger reports the corrupt ledger diagnostic", async () => {
  await fs.writeFile(ledger, '[{"id":"missing-everything-else"}]', "utf8")

  await expect(AuthorityProcessLedger.revoke()).rejects.toThrow(
    `Authority process ledger ${ledger} is corrupt; refusing unsafe process revocation`,
  )
})

test("a valid empty ledger still revokes cleanly", async () => {
  await fs.writeFile(ledger, "[]", "utf8")

  expect(await AuthorityProcessLedger.revoke()).toBe(0)
})
