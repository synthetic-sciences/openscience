import { expect, test } from "bun:test"
import path from "node:path"
import { tmpdir } from "../fixture/fixture"

test("parent-folder snapshots exclude private roots and old credentials without touching source Git or managed projects", async () => {
  await using tmp = await tmpdir({ git: true })
  const script = `
    import assert from "node:assert/strict"
    import fs from "node:fs/promises"
    import path from "node:path"
    import { $ } from "bun"
    const root = ${JSON.stringify(tmp.path)}
    for (const [target, alias] of [["secrets[1]", "data-link"], ["private-config", "config-link"]]) {
      await fs.mkdir(path.join(root, target), { recursive: true })
      await fs.symlink(path.join(root, target), path.join(root, alias), "junction")
    }
    const { Global } = await import(${JSON.stringify(new URL("../../src/global/index.ts", import.meta.url).href)})
    const { Snapshot } = await import(${JSON.stringify(new URL("../../src/snapshot/index.ts", import.meta.url).href)})
    const { Instance } = await import(${JSON.stringify(new URL("../../src/project/instance.ts", import.meta.url).href)})
    const secret = path.join(Global.Path.data, "workspace-credentials.json")
    const key = path.join(Global.Path.data, "credentials.key")
    await Bun.write(secret, "fixture-secret-cache")
    await Bun.write(key, "fixture-secret-key")
    await Bun.write(path.join(Global.Path.config, "private-config.json"), "fixture-secret-config")
    await Bun.write(path.join(Global.Path.cache, "cache-secret"), "fixture-secret-cache")
    await Bun.write(path.join(Global.Path.state, "state-secret"), "fixture-secret-state")
    await Bun.write(path.join(root, "notes.txt"), "ordinary research")
    await Bun.write(path.join(root, "secrets1", "public.txt"), "literal-path sibling")
    await $\`git add -- notes.txt ':(literal)secrets[1]/workspace-credentials.json'\`.cwd(root).quiet()
    const original = await Bun.file(path.join(root, ".git", "index")).arrayBuffer()
    await Instance.provide({ directory: root, fn: async () => {
      const git = path.join(Global.Path.data, "snapshot", Instance.project.id)
      const first = await Snapshot.track()
      assert.ok(first)
      const files = await $\`git --git-dir \${git} ls-tree -r --name-only \${first}\`.text()
      assert.ok(files.includes("notes.txt"))
      assert.ok(files.includes("secrets1/public.txt"))
      assert.ok(!/workspace-credentials|credentials.key|private-config.json|cache-secret|state-secret/.test(files))
      const absent = await $\`git --git-dir \${git} grep -F fixture-secret \${first}\`.quiet().nothrow()
      assert.equal(absent.exitCode, 1, absent.stdout.toString())

      // Simulate a snapshot index created before the private-root guard.
      await $\`git --git-dir \${git} --work-tree \${root} add -f -- ':(literal)secrets[1]/workspace-credentials.json' ':(literal)secrets[1]/credentials.key'\`.cwd(root).quiet()
      const old = (await $\`git --git-dir \${git} write-tree\`.text()).trim()
      await Bun.write(secret, "fixture-secret-current")
      const next = await Snapshot.track()
      assert.ok(next)
      assert.equal((await $\`git --git-dir \${git} grep -F fixture-secret \${next}\`.quiet().nothrow()).exitCode, 1)
      assert.deepEqual((await Snapshot.patch(old)).files, [])
      assert.equal(await Snapshot.diff(old), "")
      assert.deepEqual(await Snapshot.diffFull(old, next), [])
      const restored = await Snapshot.restore(old, [secret])
      assert.equal(restored.status, "partial")
      assert.equal(await Bun.file(secret).text(), "fixture-secret-current")
      assert.equal(await Bun.file(key).text(), "fixture-secret-key")
      assert.equal((await $\`git --git-dir \${git} cat-file -e \${old}\`.quiet().nothrow()).exitCode, 0)
      assert.deepEqual(await Bun.file(path.join(root, ".git", "index")).arrayBuffer(), original)
    }})
    const project = path.join(Global.Path.data, "projects", "2b6a0aaf-aee6-4b3c-a2d4-447c82c0703f")
    await fs.mkdir(project, { recursive: true })
    await $\`git init\`.cwd(project).quiet()
    await $\`git -c user.name=Fixture -c user.email=fixture@example.invalid commit --allow-empty -m init\`.cwd(project).quiet()
    await Bun.write(path.join(project, "paper.md"), "managed research")
    await Instance.provide({ directory: project, fn: async () => {
      const hash = await Snapshot.track()
      assert.ok(hash)
      const git = path.join(Global.Path.data, "snapshot", Instance.project.id)
      assert.equal((await $\`git --git-dir \${git} ls-tree -r --name-only \${hash}\`.text()).trim(), "paper.md")
    }})
  `
  const child = Bun.spawn([process.execPath, "--conditions=browser", "--eval", script], {
    cwd: tmp.path,
    env: {
      ...process.env,
      BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0",
      OPENSCIENCE_DATA_DIR: path.join(tmp.path, "data-link"),
      OPENSCIENCE_CONFIG_DIR: path.join(tmp.path, "config-link"),
      OPENSCIENCE_TEST_HOME: path.join(tmp.path, "home"),
      XDG_DATA_HOME: path.join(tmp.path, "legacy-data"),
      XDG_CACHE_HOME: path.join(tmp.path, "cache"),
      XDG_STATE_HOME: path.join(tmp.path, "state"),
    },
    stdout: "pipe",
    stderr: "pipe",
  })
  const [code, output, error] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  expect(code, `${output}\n${error}`).toBe(0)
}, 20_000)
