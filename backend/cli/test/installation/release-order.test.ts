import { expect, test } from "bun:test"
import path from "path"

test("production publish pushes the release commit before targeting it on GitHub", async () => {
  const script = await Bun.file(path.join(import.meta.dir, "../../../../tooling/repo/publish.ts")).text()
  const tag = script.indexOf("git push origin refs/tags/")
  const release = script.indexOf("gh release edit v${Script.version} --target ${sha}")

  expect(tag).toBeGreaterThan(-1)
  expect(release).toBeGreaterThan(tag)
  expect(script.slice(tag, release)).not.toContain(".nothrow()")
})

test("publish source gates normalize GitHub's case-insensitive repository slug", async () => {
  const workflows = ["npm-test.yml", "publish.yml"]

  for (const workflow of workflows) {
    const source = await Bun.file(path.join(import.meta.dir, `../../../../.github/workflows/${workflow}`)).text()

    expect(source).toContain(
      '[[ "${GITHUB_REPOSITORY,,}" != "synthetic-sciences/openscience" || "$GITHUB_REF" != "refs/heads/main" ]]',
    )
    expect(source).not.toContain('[[ "$GITHUB_REPOSITORY" != "synthetic-sciences/OpenScience"')
  }
})
