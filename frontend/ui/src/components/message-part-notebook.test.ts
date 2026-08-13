import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"

const source = () => readFileSync(fileURLToPath(new URL("./message-part.tsx", import.meta.url)), "utf8")
const styles = () => readFileSync(fileURLToPath(new URL("./message-part.css", import.meta.url)), "utf8")

test("canonical Python and R tools lead with results and keep code inspectable", () => {
  const part = source()
  const kernel = part.slice(
    part.indexOf("function KernelTool"),
    part.indexOf('ToolRegistry.register({\n  name: "notebook"'),
  )

  expect(part).toContain('name: "notebook"')
  expect(part).toContain('name: "rkernel"')
  expect(part).toContain('name: "python"')
  expect(part).toContain('name: "r"')
  expect(part).toContain('data-slot="kernel-tool-source"')
  expect(part).toContain("<code>{code()}</code>")
  expect(part).toContain('typeof props.input.kernel === "string"')
  expect(kernel).toContain("`env ${kernel()}`")
  expect(kernel).toContain("`run ${count()}`")
  expect(kernel).toContain("<span>{subtitle()}</span>")
  expect(part).toContain("<summary>Code</summary>")
  expect(part).toContain('data-slot="kernel-tool-result"')
  expect(part).toContain('data-slot="kernel-tool-images"')
  expect(part).toContain('props.input.action === "stop"')
  expect(part).toContain('trigger={{ title: "Kernel stopped"')
  expect(kernel).toContain("scienceTaskLabel")
  expect(kernel).toContain('props.metadata.ok === false || props.status === "error"')
  expect(kernel).toContain("`Failed · ${task()}`")
  expect(kernel).toContain('props.status === "completed" ? task()')
  expect(kernel).toContain("`Running · ${task()}`")
  expect(kernel).not.toContain("defaultOpen")
  expect(kernel.indexOf('data-slot="kernel-tool-result"')).toBeLessThan(
    kernel.indexOf('data-slot="kernel-tool-source"'),
  )
  expect(styles()).toContain("max-height: calc(5 * 1.55em + 20px)")
  expect(styles()).toContain("overflow: auto")
})
