import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"

const source = () => readFileSync(fileURLToPath(new URL("./message-part.tsx", import.meta.url)), "utf8")
const styles = () => readFileSync(fileURLToPath(new URL("./message-part.css", import.meta.url)), "utf8")

test("notebook tools keep complete source, output, and figures behind a compact summary", () => {
  const part = source()
  const kernel = part.slice(
    part.indexOf("function KernelTool"),
    part.indexOf('ToolRegistry.register({\n  name: "notebook"'),
  )

  expect(part).toContain('name: "notebook"')
  expect(part).toContain('name: "rkernel"')
  expect(part).toContain('data-slot="kernel-tool-source"')
  expect(part).toContain("<code>{code()}</code>")
  expect(part).toContain('typeof props.input.kernel === "string"')
  expect(part).toContain("<span>env {kernel()}</span>")
  expect(part).toContain("<summary>Show output</summary>")
  expect(part).toContain('data-slot="kernel-tool-output" open')
  expect(part).toContain('data-slot="kernel-tool-images"')
  expect(part).toContain('props.input.action === "stop"')
  expect(part).toContain('trigger={{ title: "Kernel stopped"')
  expect(part).toContain('title: props.status === "completed" ? "Computed" : "Computing"')
  expect(kernel).not.toContain("defaultOpen")
  expect(styles()).toContain("max-height: calc(5 * 1.55em + 20px)")
  expect(styles()).toContain("overflow: auto")
})
