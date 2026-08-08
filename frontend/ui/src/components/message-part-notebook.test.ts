import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"

const source = () => readFileSync(fileURLToPath(new URL("./message-part.tsx", import.meta.url)), "utf8")

test("notebook tools expose the source code and keep output secondary", () => {
  const part = source()

  expect(part).toContain('name: "notebook"')
  expect(part).toContain('name: "rkernel"')
  expect(part).toContain('data-slot="kernel-tool-source"')
  expect(part).toContain("<code>{code()}</code>")
  expect(part).toContain('typeof props.input.kernel === "string"')
  expect(part).toContain("<span>env {kernel()}</span>")
  expect(part).toContain("<summary>Show output</summary>")
  expect(part).toContain('title: props.status === "completed" ? "Computed" : "Computing"')
})
