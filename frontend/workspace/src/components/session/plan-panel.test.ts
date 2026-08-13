import { expect, test } from "bun:test"
import { join } from "path"

const read = (relative: string) => Bun.file(join(import.meta.dir, relative)).text()

test("planning stays adaptive instead of exposing a manual plan or act mode", async () => {
  const local = await read("../../context/local.tsx")
  expect(local).toContain('x.name === "research"')
  expect(local).not.toContain("const plan =")
  expect(local).not.toContain("plan,")

  const composer = await read("../prompt-input.tsx")
  expect(composer).not.toContain('workspace-composer__mode"')
  expect(composer).not.toContain("local.plan")
  expect(composer).not.toContain('aria-label="Composer mode"')
  expect(composer).not.toContain("Research mode")
  expect(composer).not.toContain("local.research.list()")

  const registry = await read("../settings/registry.ts")
  expect(registry).not.toContain('title: "Specialists"')
})

test("todo progress stays inside the turn's thinking disclosure instead of the composer dock", async () => {
  const session = await read("../../pages/session.tsx")
  const turn = await read("../../../../ui/src/components/session-turn.tsx")
  const parts = await read("../../../../ui/src/components/message-part.tsx")

  expect(session).not.toContain("PlanPanel")
  expect(session).not.toContain('data-component="plan-panel"')
  expect(turn).toContain("props.stepsExpanded")
  expect(parts).toContain('name: "todowrite"')
  expect(parts).toContain('data-component="todos"')
})
