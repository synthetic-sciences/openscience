import { expect, test } from "bun:test"

const source = await Bun.file(new URL("./CommandPalette.tsx", import.meta.url)).text()

test("uses a centered project command palette", async () => {
  const styles = await Bun.file(new URL("../styles/atlas.css", import.meta.url)).text()
  expect(source).toContain('class="atlas-modal atlas-fade-in command-palette"')
  expect(source).not.toContain("conversation-center")
  expect(styles).toContain(".command-palette")
  expect(styles).toContain("transform: translate(-50%, -50%)")
  expect(source).toContain('"min-height": "40px"')
  expect(source).toContain('"font-size": "13px"')
  expect(source).toContain('"font-size": "12px"')
  expect(source).toContain('role="dialog"')
  expect(source).toContain('aria-modal="true"')
})

test("wires /search through the project-scoped request helper with debounce and cancellation", () => {
  expect(source).toContain('request("/search", { signal: controller.signal }, { q })')
  expect(source).toContain("createProjectRequest({")
  expect(source).toContain("const DEBOUNCE = 250")
  expect(source).toContain("setTimeout(") // debounced fetch
  expect(source).toContain("new AbortController()")
  expect(source).toContain("inflight?.abort()") // stale requests cancelled
  expect(source).toContain("q.length >= 2") // no fetch below the server minimum
  expect(source).toContain("resolveProjectRoute(params.dir, sync.data.project)")
})

test("renders the three search groups and routes selection correctly", () => {
  expect(source).toContain('category: "sessions"')
  expect(source).toContain('category: "messages"')
  expect(source).toContain('category: "artifacts"')
  expect(source).toContain("projectHref(scope.project, scope.directory, s.id)")
  expect(source).toContain("projectHref(scope.project, scope.directory, m.sessionID)")
  expect(source).toContain("reveal(m.messageID)")
  expect(source).toContain("data-message-id") // transcript anchor for scroll-to-message
  expect(source).toContain("uiStore.openFile(scope.directory, a.path)")
})

test("keeps project search local and shows recent sessions before commands", () => {
  const scoped = source.indexOf("if (scope) {")
  const projects = source.indexOf("sync.data.project.forEach")
  expect(scoped).toBeGreaterThan(0)
  expect(projects).toBeGreaterThan(scoped)
  expect(source.slice(scoped, projects)).toContain("return list")
  expect(source).toContain('category: "recent sessions"')
  expect(source).toContain('category: "commands"')
})

test("keeps the flat selection model across search groups", () => {
  expect(source).toContain("return [...base, ...results()]")
})

test("labels the palette as local search without overpromising", () => {
  expect(source).toContain("Search this project…")
  expect(source).toContain("local search")
  expect(source).not.toContain("semantic")
})

test("shows a searching row in flight and no-matches only after completion", () => {
  expect(source).toContain("searching…")
  expect(source).toContain("filtered().length > 0 || searching()")
})
