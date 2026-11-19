import { expect, test } from "bun:test"
import { substituteFile } from "../../src/format/substitute"

test("substitutes $FILE in every command argument", () => {
  expect(substituteFile(["prettier", "--write", "$FILE", "--config", "$FILE"], "/tmp/a.ts")).toEqual([
    "prettier",
    "--write",
    "/tmp/a.ts",
    "--config",
    "/tmp/a.ts",
  ])
})

test("keeps a path containing replacement-pattern characters literal", () => {
  const file = "/tmp/report$&final.ts"
  expect(substituteFile(["fmt", "$FILE"], file)).toEqual(["fmt", file])
})

test("keeps every kind of replacement pattern in a path literal", () => {
  const files = ["/tmp/$1.ts", "/tmp/$`.ts", "/tmp/$'.ts", "/tmp/$$.ts", "/tmp/$&.ts"]
  for (const file of files) {
    expect(substituteFile(["fmt", "$FILE"], file)).toEqual(["fmt", file])
  }
})
