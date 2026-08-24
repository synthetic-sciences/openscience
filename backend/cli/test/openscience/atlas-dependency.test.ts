import { describe, expect, test } from "bun:test"
import path from "path"
import { RETIRED_PRODUCT_SKILL_NAMES } from "../../src/skill/retired"

describe("retired @synsci/atlas distribution", () => {
  const root = path.join(import.meta.dir, "..", "..")
  const repo = path.resolve(root, "..", "..")
  const retiredGraphSkills = ["initialize-atlas-graph", "initialize-research-graph"]

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

  test("does not bundle any retired Atlas or graph-initialization skill", async () => {
    const skills = path.join(root, "skills")
    const names: string[] = []
    for await (const file of new Bun.Glob("**/SKILL.md").scan({ cwd: skills, onlyFiles: true })) {
      const source = await Bun.file(path.join(skills, file)).text()
      const name = /^name:\s*(.+)$/m.exec(source)?.[1]?.trim()
      if (name) names.push(name)
    }

    for (const name of RETIRED_PRODUCT_SKILL_NAMES) expect(names).not.toContain(name)
  })

  test("does not document either retired graph-initialization skill", async () => {
    const files = [path.join(repo, "README.md"), path.join(repo, "CHANGELOG.md"), path.join(root, "README.md")]
    for (const directory of [
      path.join(repo, "docs"),
      path.join(repo, "frontend", "docs"),
      path.join(repo, "frontend", "landing", "public"),
      path.join(repo, "frontend", "workspace", "public"),
    ]) {
      for await (const file of new Bun.Glob("**/*.{md,mdx,txt,json,html}").scan({
        cwd: directory,
        absolute: true,
        onlyFiles: true,
      })) {
        files.push(file)
      }
    }

    for (const file of files) {
      const source = (await Bun.file(file).text()).toLowerCase()
      for (const name of retiredGraphSkills) expect(source, path.relative(repo, file)).not.toContain(name)
    }
  })
})
