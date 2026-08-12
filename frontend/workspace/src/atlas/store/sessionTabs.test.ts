import { describe, expect, test } from "bun:test"
import { createSessionTabs, type SessionTabStorage } from "./sessionTabs"

function memoryStorage(): SessionTabStorage {
  const values = new Map<string, string>()
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
  }
}

describe("session tabs", () => {
  test("reuses rapid session switches without duplicates", () => {
    const tabs = createSessionTabs({ storage: memoryStorage() })
    tabs.activateProject("project-a")

    for (let index = 0; index < 20; index++) tabs.open(index % 2 ? "session-a" : "session-b")

    expect(tabs.tabs()).toEqual(["session-b", "session-a"])
    expect(tabs.active()).toBe("session-a")
  })

  test("closes to the nearest tab and restores order, active state, and drafts", () => {
    const storage = memoryStorage()
    const first = createSessionTabs({ storage })
    first.activateProject("project-a")
    first.open("session-a")
    first.open("session-b")
    first.open("session-c")
    first.setDraft("session-b", true)

    expect(first.close("session-c")).toBe("session-b")
    expect(first.tabs()).toEqual(["session-a", "session-b"])

    const restored = createSessionTabs({ storage })
    restored.activateProject("project-a")
    expect(restored.tabs()).toEqual(["session-a", "session-b"])
    expect(restored.active()).toBe("session-b")
    expect(restored.dirty("session-b")).toBe(true)
  })

  test("never shares tab state between projects", () => {
    const tabs = createSessionTabs({ storage: memoryStorage() })
    tabs.activateProject("project-a")
    tabs.open("shared-session")
    tabs.setDraft("shared-session", true)
    tabs.activateProject("project-b")
    tabs.open("shared-session")

    expect(tabs.tabs()).toEqual(["shared-session"])
    expect(tabs.dirty("shared-session")).toBe(false)

    tabs.activateProject("project-a")
    expect(tabs.tabs()).toEqual(["shared-session"])
    expect(tabs.dirty("shared-session")).toBe(true)
  })

  test("reorders tabs, clamps targets, and persists the result", () => {
    const storage = memoryStorage()
    const tabs = createSessionTabs({ storage })
    tabs.activateProject("project-a")
    tabs.open("session-a")
    tabs.open("session-b")
    tabs.open("session-c")

    tabs.move("session-c", 0)
    expect(tabs.tabs()).toEqual(["session-c", "session-a", "session-b"])
    tabs.move("session-c", 99)
    expect(tabs.tabs()).toEqual(["session-a", "session-b", "session-c"])
    tabs.move("session-b", -5)
    expect(tabs.tabs()).toEqual(["session-b", "session-a", "session-c"])

    const restored = createSessionTabs({ storage })
    restored.activateProject("project-a")
    expect(restored.tabs()).toEqual(["session-b", "session-a", "session-c"])
  })

  test("tracks unread updates separately from drafts and active working state", () => {
    const storage = memoryStorage()
    const tabs = createSessionTabs({ storage })
    tabs.activateProject("project-a")
    tabs.open("session-a")
    tabs.markRead("session-a", 100)
    tabs.open("session-b")

    expect(tabs.unread("session-a", 99)).toBe(false)
    expect(tabs.unread("session-a", 101)).toBe(true)
    expect(tabs.unread("session-b", 500)).toBe(false)

    tabs.open("session-a")
    tabs.markRead("session-a", 101)
    expect(tabs.unread("session-a", 500)).toBe(false)

    const restored = createSessionTabs({ storage })
    restored.activateProject("project-a")
    restored.open("session-b")
    expect(restored.unread("session-a", 101)).toBe(false)
  })
})
