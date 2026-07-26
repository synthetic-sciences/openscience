import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"

const read = (path: string) => readFileSync(fileURLToPath(new URL(path, import.meta.url)), "utf8")

describe("session render boundary", () => {
  test("keeps session-only render dependencies behind the lazy route", () => {
    const app = read("../app.tsx")

    expect(app).toContain('const Session = lazy(() => import("@/pages/session-shell"))')
    expect(app).not.toContain("@synsci/ui/context/marked")
    expect(app).not.toContain("@synsci/ui/context/diff")
    expect(app).not.toContain("@synsci/ui/context/code")
    expect(app).not.toContain("@synsci/ui/diff")
    expect(app).not.toContain("@synsci/ui/code")
    expect(app).not.toContain("@/science/tool-renderer")
  })

  test("preserves registration and provider order inside the session shell", () => {
    const shell = read("./session-shell.tsx")
    const registration = shell.indexOf('import "@/science/tool-renderer"')
    const sessionPage = shell.indexOf('import SessionPage from "./session"')
    const marked = shell.indexOf("<MarkedProvider")
    const diff = shell.indexOf("<DiffComponentProvider")
    const code = shell.indexOf("<CodeComponentProvider")
    const children = shell.indexOf("{props.children}")

    expect(registration).toBeGreaterThan(-1)
    expect(sessionPage).toBeGreaterThan(registration)
    expect(marked).toBeGreaterThan(-1)
    expect(diff).toBeGreaterThan(marked)
    expect(code).toBeGreaterThan(diff)
    expect(children).toBeGreaterThan(code)
  })
})
