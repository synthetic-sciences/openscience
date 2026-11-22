import { expect, test } from "bun:test"
import path from "node:path"
import { Archive } from "../../src/util/archive"

test("PowerShell ZIP extraction escapes apostrophes and treats brackets literally", () => {
  const zip = path.resolve("O'Brien", "[results].zip")
  const dest = path.resolve("O'Brien", "[unpacked]")
  const quote = (value: string) => `'${value.replaceAll("'", "''")}'`
  const command = Archive.windowsExtractCommand(zip, dest)
  expect(command).toContain(`Expand-Archive -LiteralPath ${quote(zip)}`)
  expect(command).toContain(`-DestinationPath ${quote(dest)} -Force`)
  expect(command).not.toContain("Expand-Archive -Path ")
})
