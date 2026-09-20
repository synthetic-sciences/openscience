import { afterAll, expect, test } from "bun:test"
import { fileURLToPath } from "node:url"
import { createTestServer as createServer } from "../../test/vite"
import solid from "vite-plugin-solid"

const server = await createServer({
  root: fileURLToPath(new URL("../..", import.meta.url)),
  mode: "production",
  logLevel: "silent",
  plugins: [solid({ ssr: false, dev: false })],
  server: { middlewareMode: true, watch: null },
  appType: "custom",
  resolve: { conditions: ["browser", "production"], dedupe: ["solid-js"] },
  ssr: { noExternal: true, resolve: { conditions: ["browser", "production"] } },
})
const reactive = (await server.ssrLoadModule("solid-js")) as typeof import("solid-js")
const subject = (await server.ssrLoadModule("/src/atlas/FolderPicker.tsx")) as typeof import("./FolderPicker")
const paths = (await server.ssrLoadModule("/src/utils/local-path.ts")) as typeof import("../utils/local-path")

afterAll(() => server.close())

// The picker's contexts (global SDK, global sync, dialog) are not mountable here, so these
// replay the exact expressions `crumbs`, `goUp` and the parent button's `disabled` evaluate
// on a Windows home, where the base the picker navigates from is a drive root.
test("a drive root is a place the picker can navigate from", () => {
  const home = "C:\\"
  const cwd = paths.normalizeLocalPath("C:\\Research\\paper")

  // A home that is itself a root is spelled out rather than shortened to `~`.
  expect(paths.localPathBreadcrumbs(cwd, home)).toEqual([
    { label: "C:/", path: "C:/" },
    { label: "Research", path: "C:/Research" },
    { label: "paper", path: "C:/Research/paper" },
  ])
  expect(paths.localPathBreadcrumbs(cwd, "C:\\Users\\aayam")).toEqual([
    { label: "C:/", path: "C:/" },
    { label: "Research", path: "C:/Research" },
    { label: "paper", path: "C:/Research/paper" },
  ])
  expect(paths.displayLocalPath(cwd, home)).toBe("C:/Research/paper")

  const climb: string[] = []
  let current = cwd
  while (!paths.isLocalPathRoot(current)) {
    current = paths.parentLocalPath(current)
    climb.push(current)
  }
  expect(climb).toEqual(["C:/Research", "C:/"])
  expect(paths.isLocalPathRoot(current)).toBe(true)

  expect(paths.resolveTypedLocalPath("Research", "C:\\", home)).toBe("C:/Research")
})

test("a delayed validation cannot replace newer navigation", async () => {
  const owner = reactive.createRoot((dispose) => {
    const requests = subject.createRequestGeneration()
    return { requests, dispose }
  })

  let resolve!: (path: string) => void
  const validation = new Promise<string>((accept) => {
    resolve = accept
  })
  let current = "/initial"
  const older = owner.requests.next()
  const pending = validation.then((path) => {
    if (owner.requests.isCurrent(older)) current = path
  })

  current = "/newer"
  owner.requests.invalidate()
  resolve("/stale")
  await pending
  expect(current).toBe("/newer")

  const disposed = owner.requests.next()
  owner.dispose()
  expect(owner.requests.isCurrent(disposed)).toBe(false)
})
