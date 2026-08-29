import { test, expect } from "bun:test"
import os from "os"
import { PermissionNext } from "../../src/permission/next"
import { Instance } from "../../src/project/instance"
import { Storage } from "../../src/storage/storage"
import { tmpdir } from "../fixture/fixture"
import { ShellRisk } from "../../src/permission/shell-risk"

// fromConfig tests

test("fromConfig - string value becomes wildcard rule", () => {
  const result = PermissionNext.fromConfig({ bash: "allow" })
  expect(result).toEqual([{ permission: "bash", pattern: "*", action: "allow" }])
})

test("fromConfig - object value converts to rules array", () => {
  const result = PermissionNext.fromConfig({ bash: { "*": "allow", rm: "deny" } })
  expect(result).toEqual([
    { permission: "bash", pattern: "*", action: "allow" },
    { permission: "bash", pattern: "rm", action: "deny" },
  ])
})

test("fromConfig - mixed string and object values", () => {
  const result = PermissionNext.fromConfig({
    bash: { "*": "allow", rm: "deny" },
    edit: "allow",
    webfetch: "ask",
  })
  expect(result).toEqual([
    { permission: "bash", pattern: "*", action: "allow" },
    { permission: "bash", pattern: "rm", action: "deny" },
    { permission: "edit", pattern: "*", action: "allow" },
    { permission: "webfetch", pattern: "*", action: "ask" },
  ])
})

test("fromConfig - empty object", () => {
  const result = PermissionNext.fromConfig({})
  expect(result).toEqual([])
})

test("fromConfig - expands tilde to home directory", () => {
  const result = PermissionNext.fromConfig({ external_directory: { "~/projects/*": "allow" } })
  expect(result).toEqual([{ permission: "external_directory", pattern: `${os.homedir()}/projects/*`, action: "allow" }])
})

test("fromConfig - expands $HOME to home directory", () => {
  const result = PermissionNext.fromConfig({ external_directory: { "$HOME/projects/*": "allow" } })
  expect(result).toEqual([{ permission: "external_directory", pattern: `${os.homedir()}/projects/*`, action: "allow" }])
})

test("fromConfig - expands $HOME without trailing slash", () => {
  const result = PermissionNext.fromConfig({ external_directory: { $HOME: "allow" } })
  expect(result).toEqual([{ permission: "external_directory", pattern: os.homedir(), action: "allow" }])
})

test("fromConfig - does not expand tilde in middle of path", () => {
  const result = PermissionNext.fromConfig({ external_directory: { "/some/~/path": "allow" } })
  expect(result).toEqual([{ permission: "external_directory", pattern: "/some/~/path", action: "allow" }])
})

test("fromConfig - expands exact tilde to home directory", () => {
  const result = PermissionNext.fromConfig({ external_directory: { "~": "allow" } })
  expect(result).toEqual([{ permission: "external_directory", pattern: os.homedir(), action: "allow" }])
})

test("evaluate - matches expanded tilde pattern", () => {
  const ruleset = PermissionNext.fromConfig({ external_directory: { "~/projects/*": "allow" } })
  const result = PermissionNext.evaluate("external_directory", `${os.homedir()}/projects/file.txt`, ruleset)
  expect(result.action).toBe("allow")
})

test("evaluate - matches expanded $HOME pattern", () => {
  const ruleset = PermissionNext.fromConfig({ external_directory: { "$HOME/projects/*": "allow" } })
  const result = PermissionNext.evaluate("external_directory", `${os.homedir()}/projects/file.txt`, ruleset)
  expect(result.action).toBe("allow")
})

// merge tests

test("merge - simple concatenation", () => {
  const result = PermissionNext.merge(
    [{ permission: "bash", pattern: "*", action: "allow" }],
    [{ permission: "bash", pattern: "*", action: "deny" }],
  )
  expect(result).toEqual([
    { permission: "bash", pattern: "*", action: "allow" },
    { permission: "bash", pattern: "*", action: "deny" },
  ])
})

test("merge - adds new permission", () => {
  const result = PermissionNext.merge(
    [{ permission: "bash", pattern: "*", action: "allow" }],
    [{ permission: "edit", pattern: "*", action: "deny" }],
  )
  expect(result).toEqual([
    { permission: "bash", pattern: "*", action: "allow" },
    { permission: "edit", pattern: "*", action: "deny" },
  ])
})

test("merge - concatenates rules for same permission", () => {
  const result = PermissionNext.merge(
    [{ permission: "bash", pattern: "foo", action: "ask" }],
    [{ permission: "bash", pattern: "*", action: "deny" }],
  )
  expect(result).toEqual([
    { permission: "bash", pattern: "foo", action: "ask" },
    { permission: "bash", pattern: "*", action: "deny" },
  ])
})

test("merge - multiple rulesets", () => {
  const result = PermissionNext.merge(
    [{ permission: "bash", pattern: "*", action: "allow" }],
    [{ permission: "bash", pattern: "rm", action: "ask" }],
    [{ permission: "edit", pattern: "*", action: "allow" }],
  )
  expect(result).toEqual([
    { permission: "bash", pattern: "*", action: "allow" },
    { permission: "bash", pattern: "rm", action: "ask" },
    { permission: "edit", pattern: "*", action: "allow" },
  ])
})

test("merge - empty ruleset does nothing", () => {
  const result = PermissionNext.merge([{ permission: "bash", pattern: "*", action: "allow" }], [])
  expect(result).toEqual([{ permission: "bash", pattern: "*", action: "allow" }])
})

test("merge - preserves rule order", () => {
  const result = PermissionNext.merge(
    [
      { permission: "edit", pattern: "src/*", action: "allow" },
      { permission: "edit", pattern: "src/secret/*", action: "deny" },
    ],
    [{ permission: "edit", pattern: "src/secret/ok.ts", action: "allow" }],
  )
  expect(result).toEqual([
    { permission: "edit", pattern: "src/*", action: "allow" },
    { permission: "edit", pattern: "src/secret/*", action: "deny" },
    { permission: "edit", pattern: "src/secret/ok.ts", action: "allow" },
  ])
})

test("merge - config permission overrides default ask", () => {
  // Simulates: defaults have "*": "ask", config sets bash: "allow"
  const defaults: PermissionNext.Ruleset = [{ permission: "*", pattern: "*", action: "ask" }]
  const config: PermissionNext.Ruleset = [{ permission: "bash", pattern: "*", action: "allow" }]
  const merged = PermissionNext.merge(defaults, config)

  // Config's bash allow should override default ask
  expect(PermissionNext.evaluate("bash", "ls", merged).action).toBe("allow")
  // Other permissions should still be ask (from defaults)
  expect(PermissionNext.evaluate("edit", "foo.ts", merged).action).toBe("ask")
})

test("merge - config ask overrides default allow", () => {
  // Simulates: defaults have bash: "allow", config sets bash: "ask"
  const defaults: PermissionNext.Ruleset = [{ permission: "bash", pattern: "*", action: "allow" }]
  const config: PermissionNext.Ruleset = [{ permission: "bash", pattern: "*", action: "ask" }]
  const merged = PermissionNext.merge(defaults, config)

  // Config's ask should override default allow
  expect(PermissionNext.evaluate("bash", "ls", merged).action).toBe("ask")
})

// evaluate tests

test("evaluate - exact pattern match", () => {
  const result = PermissionNext.evaluate("bash", "rm", [{ permission: "bash", pattern: "rm", action: "deny" }])
  expect(result.action).toBe("deny")
})

test("evaluate - wildcard pattern match", () => {
  const result = PermissionNext.evaluate("bash", "rm", [{ permission: "bash", pattern: "*", action: "allow" }])
  expect(result.action).toBe("allow")
})

test("evaluate - last matching rule wins", () => {
  const result = PermissionNext.evaluate("bash", "rm", [
    { permission: "bash", pattern: "*", action: "allow" },
    { permission: "bash", pattern: "rm", action: "deny" },
  ])
  expect(result.action).toBe("deny")
})

test("evaluate - last matching rule wins (wildcard after specific)", () => {
  const result = PermissionNext.evaluate("bash", "rm", [
    { permission: "bash", pattern: "rm", action: "deny" },
    { permission: "bash", pattern: "*", action: "allow" },
  ])
  expect(result.action).toBe("allow")
})

test("evaluate - glob pattern match", () => {
  const result = PermissionNext.evaluate("edit", "src/foo.ts", [
    { permission: "edit", pattern: "src/*", action: "allow" },
  ])
  expect(result.action).toBe("allow")
})

test("evaluate - last matching glob wins", () => {
  const result = PermissionNext.evaluate("edit", "src/components/Button.tsx", [
    { permission: "edit", pattern: "src/*", action: "deny" },
    { permission: "edit", pattern: "src/components/*", action: "allow" },
  ])
  expect(result.action).toBe("allow")
})

test("evaluate - order matters for specificity", () => {
  // If more specific rule comes first, later wildcard overrides it
  const result = PermissionNext.evaluate("edit", "src/components/Button.tsx", [
    { permission: "edit", pattern: "src/components/*", action: "allow" },
    { permission: "edit", pattern: "src/*", action: "deny" },
  ])
  expect(result.action).toBe("deny")
})

test("evaluate - unknown permission returns ask", () => {
  const result = PermissionNext.evaluate("unknown_tool", "anything", [
    { permission: "bash", pattern: "*", action: "allow" },
  ])
  expect(result.action).toBe("ask")
})

test("evaluate - empty ruleset returns ask", () => {
  const result = PermissionNext.evaluate("bash", "rm", [])
  expect(result.action).toBe("ask")
})

test("evaluate - no matching pattern returns ask", () => {
  const result = PermissionNext.evaluate("edit", "etc/passwd", [
    { permission: "edit", pattern: "src/*", action: "allow" },
  ])
  expect(result.action).toBe("ask")
})

test("evaluate - empty rules array returns ask", () => {
  const result = PermissionNext.evaluate("bash", "rm", [])
  expect(result.action).toBe("ask")
})

test("evaluate - multiple matching patterns, last wins", () => {
  const result = PermissionNext.evaluate("edit", "src/secret.ts", [
    { permission: "edit", pattern: "*", action: "ask" },
    { permission: "edit", pattern: "src/*", action: "allow" },
    { permission: "edit", pattern: "src/secret.ts", action: "deny" },
  ])
  expect(result.action).toBe("deny")
})

test("evaluate - non-matching patterns are skipped", () => {
  const result = PermissionNext.evaluate("edit", "src/foo.ts", [
    { permission: "edit", pattern: "*", action: "ask" },
    { permission: "edit", pattern: "test/*", action: "deny" },
    { permission: "edit", pattern: "src/*", action: "allow" },
  ])
  expect(result.action).toBe("allow")
})

test("evaluate - exact match at end wins over earlier wildcard", () => {
  const result = PermissionNext.evaluate("bash", "/bin/rm", [
    { permission: "bash", pattern: "*", action: "allow" },
    { permission: "bash", pattern: "/bin/rm", action: "deny" },
  ])
  expect(result.action).toBe("deny")
})

test("evaluate - wildcard at end overrides earlier exact match", () => {
  const result = PermissionNext.evaluate("bash", "/bin/rm", [
    { permission: "bash", pattern: "/bin/rm", action: "deny" },
    { permission: "bash", pattern: "*", action: "allow" },
  ])
  expect(result.action).toBe("allow")
})

// wildcard permission tests

test("evaluate - wildcard permission matches any permission", () => {
  const result = PermissionNext.evaluate("bash", "rm", [{ permission: "*", pattern: "*", action: "deny" }])
  expect(result.action).toBe("deny")
})

test("evaluate - wildcard permission with specific pattern", () => {
  const result = PermissionNext.evaluate("bash", "rm", [{ permission: "*", pattern: "rm", action: "deny" }])
  expect(result.action).toBe("deny")
})

test("evaluate - glob permission pattern", () => {
  const result = PermissionNext.evaluate("mcp_server_tool", "anything", [
    { permission: "mcp_*", pattern: "*", action: "allow" },
  ])
  expect(result.action).toBe("allow")
})

test("evaluate - specific permission and wildcard permission combined", () => {
  const result = PermissionNext.evaluate("bash", "rm", [
    { permission: "*", pattern: "*", action: "deny" },
    { permission: "bash", pattern: "*", action: "allow" },
  ])
  expect(result.action).toBe("allow")
})

test("evaluate - wildcard permission does not match when specific exists", () => {
  const result = PermissionNext.evaluate("edit", "src/foo.ts", [
    { permission: "*", pattern: "*", action: "deny" },
    { permission: "edit", pattern: "src/*", action: "allow" },
  ])
  expect(result.action).toBe("allow")
})

test("evaluate - multiple matching permission patterns combine rules", () => {
  const result = PermissionNext.evaluate("mcp_dangerous", "anything", [
    { permission: "*", pattern: "*", action: "ask" },
    { permission: "mcp_*", pattern: "*", action: "allow" },
    { permission: "mcp_dangerous", pattern: "*", action: "deny" },
  ])
  expect(result.action).toBe("deny")
})

test("evaluate - wildcard permission fallback for unknown tool", () => {
  const result = PermissionNext.evaluate("unknown_tool", "anything", [
    { permission: "*", pattern: "*", action: "ask" },
    { permission: "bash", pattern: "*", action: "allow" },
  ])
  expect(result.action).toBe("ask")
})

test("evaluate - permission patterns sorted by length regardless of object order", () => {
  // specific permission listed before wildcard, but specific should still win
  const result = PermissionNext.evaluate("bash", "rm", [
    { permission: "bash", pattern: "*", action: "allow" },
    { permission: "*", pattern: "*", action: "deny" },
  ])
  // With flat list, last matching rule wins - so "*" matches bash and wins
  expect(result.action).toBe("deny")
})

test("evaluate - merges multiple rulesets", () => {
  const config: PermissionNext.Ruleset = [{ permission: "bash", pattern: "*", action: "allow" }]
  const approved: PermissionNext.Ruleset = [{ permission: "bash", pattern: "rm", action: "deny" }]
  // approved comes after config, so rm should be denied
  const result = PermissionNext.evaluate("bash", "rm", config, approved)
  expect(result.action).toBe("deny")
})

// disabled tests

test("disabled - returns empty set when all tools allowed", () => {
  const result = PermissionNext.disabled(["bash", "edit", "read"], [{ permission: "*", pattern: "*", action: "allow" }])
  expect(result.size).toBe(0)
})

test("disabled - disables tool when denied", () => {
  const result = PermissionNext.disabled(
    ["bash", "edit", "read"],
    [
      { permission: "*", pattern: "*", action: "allow" },
      { permission: "bash", pattern: "*", action: "deny" },
    ],
  )
  expect(result.has("bash")).toBe(true)
  expect(result.has("edit")).toBe(false)
  expect(result.has("read")).toBe(false)
})

test("disabled - disables edit/write/patch/multiedit when edit denied", () => {
  const result = PermissionNext.disabled(
    ["edit", "write", "patch", "multiedit", "bash"],
    [
      { permission: "*", pattern: "*", action: "allow" },
      { permission: "edit", pattern: "*", action: "deny" },
    ],
  )
  expect(result.has("edit")).toBe(true)
  expect(result.has("write")).toBe(true)
  expect(result.has("patch")).toBe(true)
  expect(result.has("multiedit")).toBe(true)
  expect(result.has("bash")).toBe(false)
})

test("disabled - does not disable when partially denied", () => {
  const result = PermissionNext.disabled(
    ["bash"],
    [
      { permission: "bash", pattern: "*", action: "allow" },
      { permission: "bash", pattern: "rm *", action: "deny" },
    ],
  )
  expect(result.has("bash")).toBe(false)
})

test("disabled - does not disable when action is ask", () => {
  const result = PermissionNext.disabled(["bash", "edit"], [{ permission: "*", pattern: "*", action: "ask" }])
  expect(result.size).toBe(0)
})

test("disabled - does not disable when specific allow after wildcard deny", () => {
  // Tool is NOT disabled because a specific allow after wildcard deny means
  // there's at least some usage allowed
  const result = PermissionNext.disabled(
    ["bash"],
    [
      { permission: "bash", pattern: "*", action: "deny" },
      { permission: "bash", pattern: "echo *", action: "allow" },
    ],
  )
  expect(result.has("bash")).toBe(false)
})

test("disabled - does not disable when wildcard allow after deny", () => {
  const result = PermissionNext.disabled(
    ["bash"],
    [
      { permission: "bash", pattern: "rm *", action: "deny" },
      { permission: "bash", pattern: "*", action: "allow" },
    ],
  )
  expect(result.has("bash")).toBe(false)
})

test("disabled - disables multiple tools", () => {
  const result = PermissionNext.disabled(
    ["bash", "edit", "webfetch"],
    [
      { permission: "bash", pattern: "*", action: "deny" },
      { permission: "edit", pattern: "*", action: "deny" },
      { permission: "webfetch", pattern: "*", action: "deny" },
    ],
  )
  expect(result.has("bash")).toBe(true)
  expect(result.has("edit")).toBe(true)
  expect(result.has("webfetch")).toBe(true)
})

test("disabled - wildcard permission denies all tools", () => {
  const result = PermissionNext.disabled(["bash", "edit", "read"], [{ permission: "*", pattern: "*", action: "deny" }])
  expect(result.has("bash")).toBe(true)
  expect(result.has("edit")).toBe(true)
  expect(result.has("read")).toBe(true)
})

test("disabled - specific allow overrides wildcard deny", () => {
  const result = PermissionNext.disabled(
    ["bash", "edit", "read"],
    [
      { permission: "*", pattern: "*", action: "deny" },
      { permission: "bash", pattern: "*", action: "allow" },
    ],
  )
  expect(result.has("bash")).toBe(false)
  expect(result.has("edit")).toBe(true)
  expect(result.has("read")).toBe(true)
})

// ask tests

test("ask - resolves immediately when action is allow", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const result = await PermissionNext.ask({
        sessionID: "session_test",
        permission: "bash",
        patterns: ["ls"],
        metadata: {},
        always: [],
        ruleset: [{ permission: "bash", pattern: "*", action: "allow" }],
      })
      expect(result).toBeUndefined()
    },
  })
})

test("ask - throws RejectedError when action is deny", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      await expect(
        PermissionNext.ask({
          sessionID: "session_test",
          permission: "bash",
          patterns: ["rm -rf /"],
          metadata: {},
          always: [],
          ruleset: [{ permission: "bash", pattern: "*", action: "deny" }],
        }),
      ).rejects.toBeInstanceOf(PermissionNext.DeniedError)
    },
  })
})

test("ask - returns pending promise when action is ask", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const promise = PermissionNext.ask({
        sessionID: "session_test",
        permission: "bash",
        patterns: ["ls"],
        metadata: {},
        always: [],
        ruleset: [{ permission: "bash", pattern: "*", action: "ask" }],
      })
      const settled = promise.catch((error) => error)
      // Promise should be pending, not resolved
      expect(promise).toBeInstanceOf(Promise)
      const request = (await PermissionNext.list()).find((item) => item.sessionID === "session_test")
      expect(request).toBeDefined()
      await PermissionNext.reply({ requestID: request!.id, reply: "reject" })
      expect(await settled).toBeInstanceOf(PermissionNext.RejectedError)
    },
  })
})

test("ask - rejects a pending request when its project runtime is genuinely disposed", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const pending = PermissionNext.ask({
        id: "permission_disposed",
        sessionID: "session_test",
        permission: "bash",
        patterns: ["ls"],
        metadata: {},
        always: [],
        ruleset: [{ permission: "bash", pattern: "*", action: "ask" }],
      }).catch((error) => error)

      expect(await PermissionNext.list()).toHaveLength(1)
      await Instance.dispose()
      expect(await pending).toBeInstanceOf(PermissionNext.InstanceDisposedError)
    },
  })
})

// reply tests

test("reply - once resolves the pending ask", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const askPromise = PermissionNext.ask({
        id: "permission_test1",
        sessionID: "session_test",
        permission: "bash",
        patterns: ["ls"],
        metadata: {},
        always: [],
        ruleset: [],
      })

      await PermissionNext.reply({
        requestID: "permission_test1",
        reply: "once",
      })

      await expect(askPromise).resolves.toBeUndefined()
    },
  })
})

test("reply - reject throws RejectedError", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const askPromise = PermissionNext.ask({
        id: "permission_test2",
        sessionID: "session_test",
        permission: "bash",
        patterns: ["ls"],
        metadata: {},
        always: [],
        ruleset: [],
      })

      await PermissionNext.reply({
        requestID: "permission_test2",
        reply: "reject",
      })

      await expect(askPromise).rejects.toBeInstanceOf(PermissionNext.RejectedError)
    },
  })
})

test("reply - always persists a global approval and resolves", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const askPromise = PermissionNext.ask({
        id: "permission_test3",
        sessionID: "session_test",
        permission: "bash",
        patterns: ["ls"],
        metadata: {},
        always: ["ls"],
        ruleset: [],
      })

      await PermissionNext.reply({
        requestID: "permission_test3",
        reply: "always",
      })

      await expect(askPromise).resolves.toBeUndefined()

      const standing = await PermissionNext.standing()
      expect(standing).toHaveLength(1)
      expect(standing[0].permission).toBe("bash")
      expect(standing[0].pattern).toBe("ls")
      expect(standing[0].scope).toBe("global")
    },
  })
  // Re-provide to reload state with stored permissions
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      // Stored approval should allow without asking
      const result = await PermissionNext.ask({
        sessionID: "session_test2",
        permission: "bash",
        patterns: ["ls"],
        metadata: {},
        always: [],
        ruleset: [],
      })
      expect(result).toBeUndefined()
      // Clean up the machine-scoped entry so it cannot leak into other tests.
      for (const entry of await PermissionNext.standing()) {
        expect(await PermissionNext.revoke({ id: entry.id })).toBe(true)
      }
      expect(await PermissionNext.standing()).toHaveLength(0)
    },
  })
})

test("reply - project persists for the project and is revocable", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const askPromise = PermissionNext.ask({
        id: "permission_scope1",
        sessionID: "session_test",
        permission: "bash",
        patterns: ["git status"],
        metadata: {},
        always: ["git *"],
        ruleset: [],
      })
      await PermissionNext.reply({ requestID: "permission_scope1", reply: "project" })
      await expect(askPromise).resolves.toBeUndefined()

      const standing = await PermissionNext.standing()
      expect(standing).toHaveLength(1)
      expect(standing[0].scope).toBe("project")

      // Another session in the same project inherits the approval.
      const result = await PermissionNext.ask({
        sessionID: "session_other",
        permission: "bash",
        patterns: ["git log"],
        metadata: {},
        always: [],
        ruleset: [],
      })
      expect(result).toBeUndefined()

      // After revocation, the same request asks again.
      expect(await PermissionNext.revoke({ id: standing[0].id })).toBe(true)
      const again = PermissionNext.ask({
        id: "permission_scope2",
        sessionID: "session_other",
        permission: "bash",
        patterns: ["git log"],
        metadata: {},
        always: [],
        ruleset: [],
      })
      expect(again).toBeInstanceOf(Promise)
      await PermissionNext.reply({ requestID: "permission_scope2", reply: "reject" })
      await expect(again).rejects.toBeInstanceOf(PermissionNext.RejectedError)
    },
  })
  // A different project does not inherit project-scoped approvals.
  await using other = await tmpdir({ git: true })
  await Instance.provide({
    directory: other.path,
    fn: async () => {
      const foreign = PermissionNext.ask({
        id: "permission_scope3",
        sessionID: "session_test",
        permission: "bash",
        patterns: ["git status"],
        metadata: {},
        always: [],
        ruleset: [],
      })
      expect(foreign).toBeInstanceOf(Promise)
      await PermissionNext.reply({ requestID: "permission_scope3", reply: "reject" })
      await expect(foreign).rejects.toBeInstanceOf(PermissionNext.RejectedError)
    },
  })
})

test("reply - session approval covers only the same conversation", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const askPromise = PermissionNext.ask({
        id: "permission_conv1",
        sessionID: "session_a",
        permission: "webfetch",
        patterns: ["https://example.com/data"],
        metadata: {},
        always: ["https://example.com/*"],
        ruleset: [],
      })
      await PermissionNext.reply({ requestID: "permission_conv1", reply: "session" })
      await expect(askPromise).resolves.toBeUndefined()

      // Session approvals are conversation-local, never persisted.
      expect(await PermissionNext.standing()).toHaveLength(0)

      // Same session: allowed without asking.
      const same = await PermissionNext.ask({
        sessionID: "session_a",
        permission: "webfetch",
        patterns: ["https://example.com/other"],
        metadata: {},
        always: [],
        ruleset: [],
      })
      expect(same).toBeUndefined()

      // Different session: asks again.
      const different = PermissionNext.ask({
        id: "permission_conv2",
        sessionID: "session_b",
        permission: "webfetch",
        patterns: ["https://example.com/other"],
        metadata: {},
        always: [],
        ruleset: [],
      })
      expect(different).toBeInstanceOf(Promise)
      await PermissionNext.reply({ requestID: "permission_conv2", reply: "reject" })
      await expect(different).rejects.toBeInstanceOf(PermissionNext.RejectedError)
    },
  })
})

test("reply - always on a network request lands in the network allow-list", async () => {
  const { Network } = await import("../../src/settings/network")
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const askPromise = PermissionNext.ask({
        id: "permission_net1",
        sessionID: "session_test",
        permission: "network",
        patterns: ["blocked.example"],
        metadata: { url: "https://blocked.example/data", network: { host: "blocked.example" } },
        always: ["blocked.example"],
        ruleset: [],
      })
      await PermissionNext.reply({ requestID: "permission_net1", reply: "always" })
      await expect(askPromise).resolves.toBeUndefined()

      // The grant is visible in the Network settings store, not a shadow list.
      expect((await Network.get()).custom).toContain("blocked.example")
      expect(await PermissionNext.standing()).toHaveLength(0)

      const state = await Network.get()
      await Network.set({ ...state, custom: state.custom.filter((domain) => domain !== "blocked.example") })
    },
  })
})

test("ask - spend permissions ignore wildcard allows", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      // A blanket "*": allow ruleset must not silently allow paid actions.
      const paid = PermissionNext.ask({
        id: "permission_spend1",
        sessionID: "session_test",
        permission: "websearch",
        patterns: ["some query"],
        metadata: {},
        always: ["*"],
        ruleset: [{ permission: "*", pattern: "*", action: "allow" }],
      })
      expect(paid).toBeInstanceOf(Promise)
      await PermissionNext.reply({ requestID: "permission_spend1", reply: "reject" })
      await expect(paid).rejects.toBeInstanceOf(PermissionNext.RejectedError)

      const modal = PermissionNext.ask({
        id: "permission_spend_modal",
        sessionID: "session_modal",
        permission: "modal",
        patterns: ["approved-plan-digest"],
        metadata: {},
        always: [],
        ruleset: [{ permission: "*", pattern: "*", action: "allow" }],
      })
      expect(modal).toBeInstanceOf(Promise)
      await PermissionNext.reply({ requestID: "permission_spend_modal", reply: "reject" })
      await expect(modal).rejects.toBeInstanceOf(PermissionNext.RejectedError)

      for (const [index, permission] of ["**", "?*", "mod*"].entries()) {
        const requestID = `permission_spend_glob_${index}`
        const shaped = PermissionNext.ask({
          id: requestID,
          sessionID: "session_modal_glob",
          permission: "modal",
          patterns: ["approved-plan-digest"],
          metadata: {},
          always: [],
          ruleset: [{ permission, pattern: "*", action: "allow" }],
        })
        expect(shaped).toBeInstanceOf(Promise)
        await PermissionNext.reply({ requestID, reply: "reject" })
        await expect(shaped).rejects.toBeInstanceOf(PermissionNext.RejectedError)
      }

      const exactModal = PermissionNext.ask({
        id: "permission_spend_modal_exact",
        sessionID: "session_modal_exact",
        permission: "modal",
        patterns: ["approved-plan-digest"],
        metadata: {},
        always: [],
        ruleset: [{ permission: "modal", pattern: "*", action: "allow" }],
      })
      expect(exactModal).toBeInstanceOf(Promise)
      await PermissionNext.reply({ requestID: "permission_spend_modal_exact", reply: "reject" })
      await expect(exactModal).rejects.toBeInstanceOf(PermissionNext.RejectedError)

      // Other spend permissions may still opt into explicit standing rules.
      const explicit = await PermissionNext.ask({
        sessionID: "session_test2",
        permission: "websearch",
        patterns: ["some query"],
        metadata: {},
        always: [],
        ruleset: [{ permission: "websearch", pattern: "*", action: "allow" }],
      })
      expect(explicit).toBeUndefined()

      // Non-spend permissions keep inheriting the wildcard allow.
      const free = await PermissionNext.ask({
        sessionID: "session_test3",
        permission: "bash",
        patterns: ["ls"],
        metadata: {},
        always: [],
        ruleset: [{ permission: "*", pattern: "*", action: "allow" }],
      })
      expect(free).toBeUndefined()
    },
  })
})

test("modal approvals can be scoped only to one exact immutable plan", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const digest = "a".repeat(64)
      const first = PermissionNext.ask({
        id: "permission_modal_scoped",
        sessionID: "session_modal_scoped",
        permission: "modal",
        patterns: [digest],
        metadata: {},
        always: [digest],
        ruleset: [{ permission: "*", pattern: "*", action: "allow" }],
      })
      await PermissionNext.reply({ requestID: "permission_modal_scoped", reply: "always" })
      await expect(first).resolves.toBeUndefined()

      await expect(
        PermissionNext.ask({
          sessionID: "session_modal_other_conversation",
          permission: "modal",
          patterns: [digest],
          metadata: {},
          always: [digest],
          ruleset: [],
        }),
      ).resolves.toBeUndefined()

      const different = PermissionNext.ask({
        id: "permission_modal_different",
        sessionID: "session_modal_scoped",
        permission: "modal",
        patterns: ["b".repeat(64)],
        metadata: {},
        always: ["b".repeat(64)],
        ruleset: [],
      })
      await PermissionNext.reply({ requestID: "permission_modal_different", reply: "reject" })
      await expect(different).rejects.toBeInstanceOf(PermissionNext.RejectedError)

      const standing = await PermissionNext.standing()
      expect(standing).toContainEqual(
        expect.objectContaining({ permission: "modal", pattern: digest, scope: "global" }),
      )
      for (const entry of standing.filter((entry) => entry.permission === "modal" && entry.pattern === digest)) {
        expect(await PermissionNext.revoke({ id: entry.id })).toBe(true)
      }
    },
  })
})

test("SSH approvals require an exact remote plan while local compute remains configurable", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const digest = "c".repeat(64)
      const configured: PermissionNext.Ruleset = [
        { permission: "compute_job", pattern: "*", action: "allow" },
        { permission: "*", pattern: "*", action: "allow" },
      ]
      const first = PermissionNext.ask({
        id: "permission_ssh_scoped",
        sessionID: "session_ssh_scoped",
        permission: "remote_compute",
        patterns: [digest],
        metadata: {},
        always: [digest],
        ruleset: configured,
      })
      expect(first).toBeInstanceOf(Promise)
      await PermissionNext.reply({ requestID: "permission_ssh_scoped", reply: "project" })
      await expect(first).resolves.toBeUndefined()

      await expect(
        PermissionNext.ask({
          sessionID: "session_ssh_other_conversation",
          permission: "remote_compute",
          patterns: [digest],
          metadata: {},
          always: [digest],
          ruleset: configured,
        }),
      ).resolves.toBeUndefined()

      const changed = PermissionNext.ask({
        id: "permission_ssh_changed",
        sessionID: "session_ssh_scoped",
        permission: "remote_compute",
        patterns: ["d".repeat(64)],
        metadata: {},
        always: ["d".repeat(64)],
        ruleset: configured,
      })
      expect(changed).toBeInstanceOf(Promise)
      await PermissionNext.reply({ requestID: "permission_ssh_changed", reply: "reject" })
      await expect(changed).rejects.toBeInstanceOf(PermissionNext.RejectedError)

      await expect(
        PermissionNext.ask({
          sessionID: "session_local_compute",
          permission: "compute_job",
          patterns: [digest],
          metadata: {},
          always: [],
          ruleset: configured,
        }),
      ).resolves.toBeUndefined()

      const standing = await PermissionNext.standing()
      expect(standing).toContainEqual(
        expect.objectContaining({ permission: "remote_compute", pattern: digest, scope: "project" }),
      )
      for (const entry of standing.filter(
        (entry) => entry.permission === "remote_compute" && entry.pattern === digest,
      )) {
        expect(await PermissionNext.revoke({ id: entry.id })).toBe(true)
      }
    },
  })
})

test("reply - reject cancels all pending for same session", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const askPromise1 = PermissionNext.ask({
        id: "permission_test4a",
        sessionID: "session_same",
        permission: "bash",
        patterns: ["ls"],
        metadata: {},
        always: [],
        ruleset: [],
      })

      const askPromise2 = PermissionNext.ask({
        id: "permission_test4b",
        sessionID: "session_same",
        permission: "edit",
        patterns: ["foo.ts"],
        metadata: {},
        always: [],
        ruleset: [],
      })

      // Catch rejections before they become unhandled
      const result1 = askPromise1.catch((e) => e)
      const result2 = askPromise2.catch((e) => e)

      // Reject the first one
      await PermissionNext.reply({
        requestID: "permission_test4a",
        reply: "reject",
      })

      // Both should be rejected
      expect(await result1).toBeInstanceOf(PermissionNext.RejectedError)
      expect(await result2).toBeInstanceOf(PermissionNext.RejectedError)
    },
  })
})

test("ask - checks all patterns and stops on first deny", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      await expect(
        PermissionNext.ask({
          sessionID: "session_test",
          permission: "bash",
          patterns: ["echo hello", "rm -rf /"],
          metadata: {},
          always: [],
          ruleset: [
            { permission: "bash", pattern: "*", action: "allow" },
            { permission: "bash", pattern: "rm *", action: "deny" },
          ],
        }),
      ).rejects.toBeInstanceOf(PermissionNext.DeniedError)
    },
  })
})

test("ask - allows all patterns when all match allow rules", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const result = await PermissionNext.ask({
        sessionID: "session_test",
        permission: "bash",
        patterns: ["echo hello", "ls -la", "pwd"],
        metadata: {},
        always: [],
        ruleset: [{ permission: "bash", pattern: "*", action: "allow" }],
      })
      expect(result).toBeUndefined()
    },
  })
})

test("shell risk classifier keeps audited reads, tests, and builds contained", () => {
  const commands = [
    'rg -n "permission" backend/cli/src',
    "git status --short",
    "git diff --check",
    "git log --oneline -5",
    "git branch --show-current",
    "/usr/bin/git status --short",
    "bun test backend/cli/test/permission/next.test.ts",
    "bun run typecheck",
    "npm run build",
    "pnpm test",
    "yarn lint",
    "cargo test --workspace",
    "./gradlew test",
    "go test ./...",
    "ninja",
    "meson test -C build",
    "pytest -q",
    "cd backend && rg --files | head -n 5",
    "find backend -type f -name '*.ts'",
    "sed -n '1,20p' package.json",
    "date +%s",
    "hostname",
    "file package.json",
    "tar -tf release.tar",
    "unzip -l release.zip",
  ]
  for (const command of commands) {
    expect(ShellRisk.classify(command), command).toMatchObject({ level: "contained" })
    expect(PermissionNext.risk("bash", { shell: { command } }), command).toBe("contained")
  }
})

test("shell risk classifier fails closed for destructive, remote, dynamic, and ambiguous commands", () => {
  const commands = [
    "rm -rf build",
    "rmdir generated",
    "mv output final",
    "cp source target",
    "git reset --hard HEAD~1",
    "git clean -fdx",
    "git checkout -- package.json",
    "git restore --source=HEAD --worktree .",
    "git rebase main",
    "git push --force-with-lease origin main",
    "git push -f origin main",
    "git -c diff.external=./evil diff",
    "git diff --ext-diff",
    "kill -TERM 1234",
    "pkill -f worker",
    "launchctl unload service.plist",
    "psql -c 'DROP TABLE runs'",
    "kubectl delete namespace research",
    "aws s3 rm s3://bucket --recursive",
    "gcloud projects delete project-id",
    "az group delete --name research",
    "docker rm -f worker",
    "echo result > result.txt",
    "cat < input.txt",
    "printf ok 2>&1",
    "echo $(git status --short)",
    "echo `date`",
    "rg TODO &",
    "if rg TODO; then echo yes; fi",
    "unknown-command && rg TODO",
    "PATH=. rg TODO",
    "./rg TODO",
    "sed -i.bak 's/a/b/' file.txt",
    "find . -type f -delete",
    "find . -type f -fls result.txt",
    "sort -oresult.txt input.txt",
    "tar -tf release.tar --delete file.txt",
    "tar -tf release.tar --checkpoint-action=exec=rm",
    "date 010112002026",
    "hostname replacement-host",
    "file -C -m custom.magic",
    "ninja install",
    "meson install -C build",
    "npm install package",
    "bun run deploy",
    'python -c \'open("result.txt", "w").write("x")\'',
  ]
  for (const command of commands) {
    expect(ShellRisk.classify(command), command).toMatchObject({ level: "risky" })
    expect(PermissionNext.risk("bash", { shell: { command } }), command).toBe("risky")
  }
  expect(PermissionNext.risk("bash", {})).toBe("unknown")
})

test("shell risk script and build target parsing stays linear on adversarial names", () => {
  const valid = `test:${"unit-".repeat(20_000)}final`
  const ambiguous = `ci-${"--".repeat(20_000)}:`

  expect(ShellRisk.classify(`bun run ${valid}`)).toMatchObject({ level: "contained" })
  expect(ShellRisk.classify(`make ${valid}`)).toMatchObject({ level: "contained" })
  expect(ShellRisk.classify(`bun run ${ambiguous}`)).toMatchObject({ level: "risky" })
  expect(ShellRisk.classify(`make ${ambiguous}`)).toMatchObject({ level: "risky" })
})

test("project action modes are execution-time authority floors", () => {
  expect(PermissionNext.risk("provider_compute")).toBe("risky")
  expect(PermissionNext.modeAction({ mode: "ask", permission: "edit", configured: "allow", granted: "allow" })).toBe(
    "ask",
  )
  expect(PermissionNext.modeAction({ mode: "ask", permission: "network", configured: "allow", granted: "allow" })).toBe(
    "ask",
  )
  expect(PermissionNext.modeAction({ mode: "ask", permission: "read", configured: "allow", granted: "allow" })).toBe(
    "allow",
  )

  expect(PermissionNext.modeAction({ mode: "approve", permission: "edit", configured: "allow", granted: "ask" })).toBe(
    "allow",
  )
  expect(
    PermissionNext.modeAction({ mode: "approve", permission: "network", configured: "allow", granted: "ask" }),
  ).toBe("ask")
  expect(
    PermissionNext.modeAction({ mode: "approve", permission: "network", configured: "allow", granted: "allow" }),
  ).toBe("allow")

  expect(PermissionNext.modeAction({ mode: "full", permission: "network", configured: "allow", granted: "ask" })).toBe(
    "allow",
  )
  expect(
    PermissionNext.modeAction({ mode: "full", permission: "future_provider", configured: "allow", granted: "allow" }),
  ).toBe("ask")
  expect(PermissionNext.modeAction({ mode: "full", permission: "network", configured: "deny", granted: "allow" })).toBe(
    "deny",
  )

  const safeShell = { shell: { command: "rg --files" } }
  const destructiveShell = { shell: { command: "rm -rf build" } }
  expect(
    PermissionNext.modeAction({
      mode: "approve",
      permission: "bash",
      configured: "allow",
      granted: "ask",
      metadata: safeShell,
    }),
  ).toBe("allow")
  expect(
    PermissionNext.modeAction({
      mode: "approve",
      permission: "bash",
      configured: "allow",
      granted: "allow",
      metadata: destructiveShell,
    }),
  ).toBe("ask")
  expect(
    PermissionNext.modeAction({
      mode: "ask",
      permission: "bash",
      configured: "allow",
      granted: "allow",
      metadata: safeShell,
    }),
  ).toBe("ask")
  expect(
    PermissionNext.modeAction({
      mode: "full",
      permission: "bash",
      configured: "allow",
      granted: "ask",
      metadata: destructiveShell,
    }),
  ).toBe("allow")
  expect(
    PermissionNext.modeAction({
      mode: "full",
      permission: "bash",
      configured: "deny",
      granted: "allow",
      metadata: destructiveShell,
    }),
  ).toBe("deny")
})

test("Ask risky shell floor cannot be weakened by standing approval or pending settlement", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const request = (id: string, sessionID: string) =>
        PermissionNext.ask({
          id,
          sessionID,
          permission: "bash",
          patterns: ["rm -rf build"],
          metadata: { shell: { command: "rm -rf build" } },
          always: ["rm *"],
          ruleset: [{ permission: "bash", pattern: "*", action: "allow" }],
          mode: "approve",
        })

      const first = request("permission_shell_floor_first", "session_shell_floor")
      const second = request("permission_shell_floor_second", "session_shell_floor")
      expect((await PermissionNext.list()).map((item) => item.id)).toEqual(
        expect.arrayContaining(["permission_shell_floor_first", "permission_shell_floor_second"]),
      )

      await PermissionNext.reply({ requestID: "permission_shell_floor_first", reply: "project" })
      await expect(first).resolves.toBeUndefined()
      expect((await PermissionNext.list()).some((item) => item.id === "permission_shell_floor_second")).toBe(true)
      await PermissionNext.reply({ requestID: "permission_shell_floor_second", reply: "reject" })
      await expect(second).rejects.toBeInstanceOf(PermissionNext.RejectedError)

      const later = request("permission_shell_floor_later", "session_shell_floor_later")
      expect((await PermissionNext.list()).some((item) => item.id === "permission_shell_floor_later")).toBe(true)
      await PermissionNext.reply({ requestID: "permission_shell_floor_later", reply: "reject" })
      await expect(later).rejects.toBeInstanceOf(PermissionNext.RejectedError)

      await expect(
        PermissionNext.ask({
          sessionID: "session_shell_floor_safe",
          permission: "bash",
          patterns: ["rg --files"],
          metadata: { shell: { command: "rg --files" } },
          always: ["rg *"],
          ruleset: [{ permission: "bash", pattern: "*", action: "allow" }],
          mode: "approve",
        }),
      ).resolves.toBeUndefined()

      await expect(
        PermissionNext.ask({
          sessionID: "session_shell_floor_full",
          permission: "bash",
          patterns: ["rm -rf build"],
          metadata: { shell: { command: "rm -rf build" } },
          always: ["rm *"],
          ruleset: [{ permission: "bash", pattern: "*", action: "allow" }],
          mode: "full",
        }),
      ).resolves.toBeUndefined()
    },
  })
})

test("Ask always ignores prior grants while Ask risky requires a user grant", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const first = PermissionNext.ask({
        id: "permission_mode_first",
        sessionID: "session_mode_floor",
        permission: "network",
        patterns: ["api.example.test"],
        metadata: {},
        always: ["api.example.test"],
        ruleset: [{ permission: "network", pattern: "*", action: "ask" }],
        mode: "approve",
      })
      await PermissionNext.reply({ requestID: "permission_mode_first", reply: "session" })
      await expect(first).resolves.toBeUndefined()

      const strict = PermissionNext.ask({
        id: "permission_mode_strict",
        sessionID: "session_mode_floor",
        permission: "network",
        patterns: ["api.example.test"],
        metadata: {},
        always: ["api.example.test"],
        ruleset: [{ permission: "network", pattern: "*", action: "allow" }],
        mode: "ask",
      })
      expect((await PermissionNext.list()).some((request) => request.id === "permission_mode_strict")).toBe(true)
      await PermissionNext.reply({ requestID: "permission_mode_strict", reply: "reject" })
      await expect(strict).rejects.toBeInstanceOf(PermissionNext.RejectedError)

      const configured = PermissionNext.ask({
        id: "permission_mode_configured",
        sessionID: "session_mode_configured",
        permission: "network",
        patterns: ["other.example.test"],
        metadata: {},
        always: ["other.example.test"],
        ruleset: [{ permission: "network", pattern: "*", action: "allow" }],
        mode: "approve",
      })
      await PermissionNext.reply({ requestID: "permission_mode_configured", reply: "reject" })
      await expect(configured).rejects.toBeInstanceOf(PermissionNext.RejectedError)

      await expect(
        PermissionNext.ask({
          sessionID: "session_mode_full",
          permission: "network",
          patterns: ["full.example.test"],
          metadata: {},
          always: ["full.example.test"],
          ruleset: [{ permission: "network", pattern: "*", action: "allow" }],
          mode: "full",
        }),
      ).resolves.toBeUndefined()
    },
  })
})
