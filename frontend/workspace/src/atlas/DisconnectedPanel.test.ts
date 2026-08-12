import { expect, test } from "bun:test"
import { fileURLToPath } from "node:url"

const file = fileURLToPath(new URL("./DisconnectedPanel.tsx", import.meta.url))

test("connection recovery uses the shared button system and consistent action casing", async () => {
  const source = await Bun.file(file).text()

  expect(source).toContain('import { Button } from "@synsci/ui/button"')
  expect(source).toContain('"Checking…" : "Retry Now"')
  expect(source).toContain("Switch Server")
  expect(source).not.toContain('"checking…" : "retry now"')
  expect(source).not.toMatch(/>\s*switch server\s*</)
})
