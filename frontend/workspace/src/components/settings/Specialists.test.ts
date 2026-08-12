import { afterAll, describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { createServer } from "vite"
import solid from "vite-plugin-solid"
import { SPECIALIST_GROUPS, isVisibleSpecialist, specialistGroupFor } from "./specialist-catalog"

const server = await createServer({
  root: fileURLToPath(new URL("../../..", import.meta.url)),
  mode: "production",
  logLevel: "silent",
  plugins: [solid({ ssr: false, dev: false })],
  server: { middlewareMode: true },
  appType: "custom",
  resolve: { conditions: ["browser", "production"], dedupe: ["solid-js", "solid-js/web"] },
  ssr: {
    noExternal: true,
    resolve: { conditions: ["browser", "production"] },
  },
})
const subject = (await server.ssrLoadModule(
  "/src/components/settings/Specialists.tsx",
)) as typeof import("./Specialists")

afterAll(() => server.close())

const source = () => readFileSync(fileURLToPath(new URL("./Specialists.tsx", import.meta.url)), "utf8")
const styles = () => readFileSync(fileURLToPath(new URL("./specialists.css", import.meta.url)), "utf8")

describe("specialist catalog", () => {
  test("shows built-in subagents while hiding implementation agents and plan mode", () => {
    expect(isVisibleSpecialist({ name: "write" })).toBe(true)
    expect(isVisibleSpecialist({ name: "literature-review" })).toBe(true)
    expect(isVisibleSpecialist({ name: "reviewer" })).toBe(true)
    expect(isVisibleSpecialist({ name: "artifact-reviewer", hidden: true })).toBe(false)
    expect(isVisibleSpecialist({ name: "title" })).toBe(false)
    expect(isVisibleSpecialist({ name: "compaction" })).toBe(false)
    expect(isVisibleSpecialist({ name: "plan" })).toBe(false)
  })

  test("uses sentence case for specialist actions", () => {
    const specialists = source()

    expect(specialists).toContain("<span>Add specialist</span>")
    expect(specialists).toContain('"Create specialist"')
    expect(specialists).toContain('label="Cancel"')
    expect(specialists).not.toContain('label="add specialist"')
    expect(specialists).not.toContain("<AddMenu")
  })

  test("uses a restrained semantic icon set and real delegation controls", () => {
    const specialists = source()

    expect(specialists).toContain('biology: "flask"')
    expect(specialists).toContain('physics: "atom"')
    expect(specialists).toContain('"literature-review": "book-open"')
    expect(specialists).toContain('data-action="specialist-delegation"')
    expect(specialists).toContain('data-action="specialist-reviewer"')
    expect(specialists).toContain('fallback={<span class="specialists-agent__session-only">Always available</span>}')
    expect(specialists).toContain("<SpecialistIcon icon={icon()} />")
    expect(specialists).toContain('class="specialists-agent__availability"')
    expect(specialists).not.toContain("<Icon name={mode().icon}")
    expect(specialists).not.toContain('<SpecialistIcon icon="glasses" />')
    expect(specialists).not.toContain("monogram={label().slice(0, 1)}")
    expect(subject.specialistIconFor({ name: "biology" })).toBe("flask")
    expect(subject.specialistIconFor({ name: "custom-code-reviewer", description: "Audits software changes" })).toBe(
      "code",
    )
    expect(subject.specialistIconFor({ name: "unclassified-specialist" })).toBe("task")
  })

  test("uses the same compact filter menu as the rest of settings", () => {
    const specialists = source()

    expect(specialists).toContain("<FilterMenu")
    expect(specialists).toContain('ariaLabel="Filter specialists by mode"')
    expect(specialists).toContain('label: "Session"')
    expect(specialists).toContain('label: "Delegated"')
    expect(subject.matchesModeFilter("primary", "primary")).toBe(true)
    expect(subject.matchesModeFilter("all", "primary")).toBe(true)
    expect(subject.matchesModeFilter("subagent", "primary")).toBe(false)
    expect(subject.matchesModeFilter("subagent", "subagent")).toBe(true)
    expect(subject.matchesModeFilter("all", "subagent")).toBe(true)
    expect(subject.matchesModeFilter("primary", "subagent")).toBe(false)
  })

  test("explains specialist availability without implementation language", () => {
    expect(subject.specialistModeMeta("primary")).toEqual({ label: "Session", canDelegate: false })
    expect(subject.specialistModeMeta("subagent")).toEqual({
      label: "Delegated",
      canDelegate: true,
    })
    expect(subject.specialistModeMeta("all")).toEqual({
      label: "Session + delegated",
      canDelegate: true,
    })
  })

  test("segregates built-ins by research role rather than one undifferentiated list", () => {
    const specialists = source()

    expect(SPECIALIST_GROUPS.map((group) => group.title)).toEqual([
      "Research",
      "Review and writing",
      "Workspace support",
    ])
    expect(specialistGroupFor({ name: "biology" })).toBe("research")
    expect(specialistGroupFor({ name: "critique" })).toBe("review")
    expect(specialistGroupFor({ name: "literature-review" })).toBe("review")
    expect(specialistGroupFor({ name: "explore" })).toBe("workspace")
    expect(specialists).toContain('title="Specialist catalog"')
    expect(specialists).toContain('class="specialists-catalog"')
    expect(specialists).toContain('class="settings-card specialists-group__list" role="list"')
  })

  test("uses flat Apple-like groups with tactile, accessible controls", () => {
    const css = styles()

    expect(css).toMatch(/\.specialists-panel \.settings-card\s*\{[^}]*gap: 2px;[^}]*padding: 4px;[^}]*border: 0/s)
    expect(css).toMatch(
      /\.specialists-panel \.settings-row\.specialists-agent\s*\{[^}]*display: grid;[^}]*grid-template-columns: 28px minmax\(0, 1fr\) max-content max-content;[^}]*border-radius: var\(--settings-radius-control\);[^}]*background: transparent/s,
    )
    expect(css).toMatch(/\.specialists-panel \.settings-row\.specialists-agent\s*\{[^}]*background-color 150ms ease/s)
    expect(css).toMatch(/@container specialists-panel \(max-width: 360px\)[\s\S]*grid-column: 2 \/ -1/)
    expect(css).toContain("min-height: 44px")
    expect(css).toContain("@media (prefers-reduced-motion: reduce)")
    expect(css).toMatch(/\.specialists-panel \.settings-control\s*\{[^}]*height: 32px/s)
    expect(css).not.toContain("var(--settings-accent)")
    expect(css).not.toContain(".specialists-agent + .specialists-agent::before")
  })

  test("specialist delegation rules preserve wildcard and unrelated permissions", () => {
    const before = {
      bash: "ask",
      task: { "*": "deny", biology: "allow" },
    }

    expect(subject.taskAction(before, "biology")).toBe("allow")
    expect(subject.taskAction(before, "physics")).toBe("deny")
    expect(subject.taskAction({ task: "ask" }, "biology")).toBe("ask")
    expect(subject.taskAction("deny", "biology")).toBe("deny")
    expect(subject.taskAction(undefined, "biology")).toBe("allow")
    expect(subject.taskAction({ task: { "bio*": "deny", "*": "allow" } }, "biology")).toBe("allow")
    expect(subject.taskAction({ task: { "*": "allow", "bio*": "deny" } }, "biology")).toBe("deny")

    const change = subject.taskPermissionChange(before, "physics", true)
    expect((change.optimistic as Record<string, unknown>).bash).toBe("ask")
    expect(change.optimistic.task).toEqual({ "*": "deny", biology: "allow", physics: "allow" })
    expect(change.patch).toEqual({
      task: { "*": "deny", biology: "allow", physics: "allow" },
    })
    expect(
      subject.taskAction(subject.taskPermissionChange(change.optimistic, "biology", false).optimistic, "biology"),
    ).toBe("deny")
    const ordered = subject.taskPermissionChange({ task: { biology: "allow", "*": "allow" } }, "biology", false)
    expect(Object.keys(ordered.patch.task)).toEqual(["*", "biology"])
    expect(subject.taskAction(ordered.optimistic, "biology")).toBe("deny")
    const global = subject.taskPermissionChange("deny", "biology", true)
    expect((global.optimistic as Record<string, unknown>)["*"]).toBe("deny")
    expect(global.optimistic.task).toEqual({ biology: "allow" })
    expect(
      subject.restoreExactTaskPermission(
        { task: { "*": "allow", biology: "deny", physics: "deny" } },
        { task: { "*": "allow", biology: "allow" } },
        "biology",
      ).task,
    ).toEqual({ "*": "allow", biology: "allow", physics: "deny" })
  })
})
