import { expect, test } from "bun:test"
import { Agent } from "../../src/agent/agent"
import { Instance } from "../../src/project/instance"
import { childPermissionRules, TaskTool } from "../../src/tool/task"
import { PermissionNext } from "../../src/permission/next"
import { tmpdir } from "../fixture/fixture"

test("Task advertises only generic internal profiles while legacy agents remain retrievable", async () => {
  await using tmp = await tmpdir()
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const research = await Agent.get("research")
      const task = await TaskTool.init({ agent: research })

      expect(task.description).toContain("- explore:")
      expect(task.description).toContain("- execute:")
      expect(task.description).toContain("- review:")
      expect(task.description).not.toContain("- biology:")
      expect(task.description).not.toContain("- physics:")
      expect(task.description).not.toContain("- literature-review:")

      expect(await Agent.get("biology")).toBeDefined()
      expect(await Agent.get("reviewer")).toBeDefined()
      expect(await Agent.get("plan")).toBeDefined()
    },
  })
})

test("child sessions deny recursive delegation even when a profile allows Task", () => {
  const configuredProfile = [{ permission: "task", pattern: "*", action: "allow" as const }]
  const child = childPermissionRules()

  expect(PermissionNext.evaluate("task", "explore", configuredProfile, child).action).toBe("deny")
  expect(PermissionNext.disabled(["task"], child)).toContain("task")
})
