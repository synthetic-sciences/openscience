import { expect, test } from "bun:test"
import path from "node:path"
import { tmpdir } from "../fixture/fixture"

test("release notes include team and automation changes without community attribution", async () => {
  await using tmp = await tmpdir()
  const run = async (args: string[], author = "Release Fixture") => {
    const child = Bun.spawn(args, {
      cwd: tmp.path,
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: author,
        GIT_AUTHOR_EMAIL: "fixture@example.com",
        GIT_COMMITTER_NAME: "Release Fixture",
        GIT_COMMITTER_EMAIL: "fixture@example.com",
        HUSKY: "0",
      },
      stdout: "pipe",
      stderr: "pipe",
    })
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ])
    if (code !== 0) throw new Error(stderr)
    return stdout
  }
  await run(["git", "init"])
  await run(["git", "-c", "commit.gpgsign=false", "commit", "--allow-empty", "-m", "Initial release"])
  await run(["git", "tag", "v1.0.0"])
  const authors = [
    "KB",
    "kb-SyntheticSciences",
    "Synthetic Sciences",
    "syntheticsciences",
    "synthetic-sciences",
    "Aayam Bansal",
    "Ishaan Gangwani",
    "dependabot[bot]",
    "dependabot",
    "github-actions[bot]",
    "openscience-agent[bot]",
    "another-automation[bot]",
    "External Scientist",
  ]
  for (const [index, author] of authors.entries()) {
    await Bun.write(path.join(tmp.path, "backend/cli/change.txt"), String(index))
    await run(["git", "add", "."])
    await run(["git", "-c", "commit.gpgsign=false", "commit", "-m", `fix: improve behavior ${index}`], author)
  }
  const output = await run([process.execPath, path.resolve(import.meta.dir, "../../../../tooling/repo/changelog.ts")])
  const notes = output.split("=== Final Notes ===")[1]!
  for (const [index, author] of authors.entries()) {
    expect(notes).toContain(`- Improve behavior ${index}`)
    if (author !== "External Scientist") expect(notes).not.toContain(author)
  }
  expect(notes).toContain("Thank you to 1 community contributor:")
  expect(notes).toContain("- External Scientist:")
  expect(notes).toContain("(External Scientist)")
})
