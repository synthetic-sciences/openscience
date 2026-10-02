import { $ } from "bun"
import { expect, test } from "bun:test"
import { Project } from "../../src/project/project"
import { Server } from "../../src/server/server"
import { fullAccessExecution, tmpdir } from "../fixture/fixture"

for (const tracked of [false, true]) {
  test(`pushes the requested branch with ${tracked ? "its own upstream" : "a new upstream"}`, async () => {
    await using access = await fullAccessExecution()
    await using local = await tmpdir({ git: true })
    await using origin = await tmpdir()
    await using other = await tmpdir()
    await $`git init --bare ${origin.path}`.quiet()
    await $`git init --bare ${other.path}`.quiet()
    const git = (args: string[]) => $`git ${args}`.cwd(local.path).quiet()
    await git(["branch", "-M", "main"])
    await git(["remote", "add", "origin", origin.path])
    await git(["remote", "add", "other", other.path])
    await git(["push", "-u", "origin", "main"])
    await git(["switch", "-c", "selected"])
    if (tracked) await git(["push", "-u", "other", "selected:destination"])
    await git(["commit", "--allow-empty", "-m", "selected change"])
    const selected = (await git(["rev-parse", "HEAD"]).text()).trim()
    await git(["switch", "main"])
    const main = (await git(["rev-parse", "HEAD"]).text()).trim()
    const created = await Project.fromDirectory(local.path)
    const response = await Server.internalFetch()("http://openscience.internal/api/repo/push", {
      method: "POST",
      headers: { "content-type": "application/json", "x-openscience-project": created.project.id },
      body: JSON.stringify({ branch: "selected" }),
    })
    const body = await response.json()
    expect({ status: response.status, body }).toMatchObject({ status: 200, body: { pushed: true } })
    const remote = tracked ? other.path : origin.path
    const branch = tracked ? "destination" : "selected"
    expect((await $`git --git-dir=${remote} rev-parse refs/heads/${branch}`.quiet().text()).trim()).toBe(selected)
    expect((await $`git --git-dir=${origin.path} rev-parse refs/heads/main`.quiet().text()).trim()).toBe(main)
    expect((await git(["branch", "--show-current"]).text()).trim()).toBe("main")
    expect((await git(["rev-parse", "--abbrev-ref", "selected@{upstream}"]).text()).trim()).toBe(
      tracked ? "other/destination" : "origin/selected",
    )
  }, 30_000)
}
