import { describe, expect, test } from "bun:test"
import path from "path"

describe("retired @synsci/atlas distribution", () => {
  const root = path.join(import.meta.dir, "..", "..")

  async function pkgJson() {
    return (await Bun.file(path.join(root, "package.json")).json()) as {
      optionalDependencies?: Record<string, string>
    }
  }

  test("does not declare the Atlas companion", async () => {
    expect((await pkgJson()).optionalDependencies?.["@synsci/atlas"]).toBeUndefined()
  })

  test("does not offer or install Atlas from first-run and account status", async () => {
    const onboard = await Bun.file(path.join(root, "src", "cli", "onboard.ts")).text()
    const connect = await Bun.file(path.join(root, "src", "cli", "cmd", "connect.ts")).text()

    expect(onboard).not.toContain("@synsci/atlas")
    expect(onboard).not.toContain("offerAtlasCli")
    expect(connect).not.toContain("atlas companion")
    expect(connect).not.toContain("Managed compute:")
  })
})
