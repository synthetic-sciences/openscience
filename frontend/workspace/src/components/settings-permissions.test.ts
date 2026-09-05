import { describe, expect, test } from "bun:test"
import {
  commitPermissionDefault,
  permissionActionFor,
  permissionChange,
  permissionDefaultFor,
} from "./settings/permission-defaults"

const panel = await Bun.file(new URL("./settings/Permissions.tsx", import.meta.url)).text()

describe("permission defaults shown in Settings", () => {
  test("matches the backend base rules for sensitive fallback permissions", () => {
    expect(permissionDefaultFor("external_directory")).toBe("ask")
    expect(permissionDefaultFor("doom_loop")).toBe("ask")
  })

  test("matches the backend wildcard allow default for ordinary tools", () => {
    for (const permission of ["read", "edit", "bash", "webfetch", "skill"]) {
      expect(permissionDefaultFor(permission)).toBe("allow")
    }
  })

  test("preserves patterned rules while changing only their default action", () => {
    const change = permissionChange({ bash: { "git *": "allow", "*": "ask" }, read: "deny" }, "bash", "deny")
    expect(change.patch as Record<string, unknown>).toEqual({ bash: { "git *": "allow", "*": "deny" } })
    expect(change.optimistic).toEqual({ bash: { "git *": "allow", "*": "deny" }, read: "deny" })
    expect(permissionActionFor(change.optimistic, "bash")).toBe("deny")
  })

  test("serializes config writes and restores the confirmed snapshot on failure", async () => {
    let permission: unknown = { bash: "allow", read: "deny" }
    let busy = false
    const hooks = {
      isBusy: () => busy,
      permission: () => permission,
      setPermission: (next: unknown) => (permission = next),
      setBusy: (next: boolean) => (busy = next),
      write: async () => {
        throw new Error("write failed")
      },
    }
    expect(await commitPermissionDefault("bash", "deny", hooks)).toEqual({ ok: false, error: "write failed" })
    expect(permission).toEqual({ bash: "allow", read: "deny" })
    expect(busy).toBe(false)
  })
})
