import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"

const source = () => readFileSync(fileURLToPath(new URL("./message-part.tsx", import.meta.url)), "utf8")

test("saved workspace artifacts render a versioned receipt", () => {
  const part = source()

  expect(part).toContain('name: "artifact"')
  expect(part).toContain('data-component="saved-artifact-tool"')
  expect(part).toContain('title: saved() ? "Saved artifact"')
  expect(part).toContain("sha256 {artifact().sha256.slice(0, 12)}")
  expect(part).toContain("<summary>Show save receipt</summary>")
})
