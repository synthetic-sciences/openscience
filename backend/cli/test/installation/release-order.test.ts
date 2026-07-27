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
