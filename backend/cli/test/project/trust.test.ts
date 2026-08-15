import { expect, test } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { Config } from "../../src/config/config"
import { MCP } from "../../src/mcp"
import { Plugin } from "../../src/plugin"
import { Instance } from "../../src/project/instance"
import { Project } from "../../src/project/project"
import { ProjectTrust } from "../../src/project/trust"
import { Server } from "../../src/server/server"
import { Skill } from "../../src/skill"
import { Worktree } from "../../src/worktree"
import { Global } from "../../src/global"
import { Storage } from "../../src/storage/storage"
import { Bus } from "../../src/bus"
import { tmpdir } from "../fixture/fixture"

async function skill(file: string, name: string) {
  await fs.mkdir(path.dirname(file), { recursive: true })
  await Bun.write(
    file,
    `---
name: ${name}
description: ${name} trust test skill.
---

# ${name}
`,
  )
}

async function containedExecution() {
  const previous = (await Config.trustedSandbox()).enabled
  await Config.setSandbox({ enabled: true })
  return {
    async [Symbol.asyncDispose]() {
      await Config.setSandbox({ enabled: previous })
    },
  }
}

test("repeated trust decisions preserve authority until the state actually changes", async () => {
  await using tmp = await tmpdir()
  await using stale = await tmpdir()
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const initial = await ProjectTrust.status(Instance.project)
      const trusted = await ProjectTrust.update(Instance.project, { trusted: true, root: initial.root })
      const first = await Storage.read<{ revision: number }>(["authority", "revision"])

      const repeated = await ProjectTrust.update(Instance.project, { trusted: true, root: initial.root })
      const second = await Storage.read<{ revision: number }>(["authority", "revision"])
      expect(repeated.revision).toBe(trusted.revision)
      expect(second.revision).toBe(first.revision)

      await expect(ProjectTrust.update(Instance.project, { trusted: true, root: stale.path })).rejects.toBeInstanceOf(
        ProjectTrust.RootMismatchError,
      )
      expect((await ProjectTrust.status(Instance.project)).revision).toBe(trusted.revision)
      expect((await Storage.read<{ revision: number }>(["authority", "revision"])).revision).toBe(first.revision)

      const revoked = await ProjectTrust.update(Instance.project, { trusted: false })
      const revokedSignal = await Storage.read<{ revision: number }>(["authority", "revision"])
      expect(revoked.revision).toBe(trusted.revision + 1)
      expect(revokedSignal.revision).toBe(first.revision + 1)

      const repeatedRevoke = await ProjectTrust.update(Instance.project, { trusted: false })
      expect(repeatedRevoke.revision).toBe(revoked.revision)
      expect((await Storage.read<{ revision: number }>(["authority", "revision"])).revision).toBe(
        revokedSignal.revision,
      )
    },
  })
})

test("an identical trust decision retries cleanup left pending by a failed reaper", async () => {
  await using tmp = await tmpdir()
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const initial = await ProjectTrust.status(Instance.project)
      await ProjectTrust.update(Instance.project, { trusted: true, root: initial.root })

      let attempts = 0
      const unsubscribe = Bus.subscribe(ProjectTrust.Event.Changed, (event) => {
        if (event.properties.status.state !== "revoked") return
        attempts += 1
        if (attempts === 1) throw new Error("simulated reaper failure")
      })

      try {
        await expect(ProjectTrust.update(Instance.project, { trusted: false })).rejects.toThrow(
          "simulated reaper failure",
        )
        expect((await ProjectTrust.status(Instance.project)).state).toBe("revoked")
        expect((await Storage.read<{ pending: boolean }>(["authority", "revision"])).pending).toBe(true)

        const retried = await ProjectTrust.update(Instance.project, { trusted: false })
        expect(retried.state).toBe("revoked")
        expect(attempts).toBe(2)
        expect((await Storage.read<{ pending: boolean }>(["authority", "revision"])).pending).toBe(false)
      } finally {
        unsubscribe()
      }
    },
  })
})

test("project code is inspectable but in-process plugins stay blocked by the execution sandbox", async () => {
  await using _sandbox = await containedExecution()
  await using tmp = await tmpdir({
    init: async (dir) => {
      const local = path.join(dir, ".openscience")
      const marker = path.join(dir, "executed")
      await fs.mkdir(path.join(local, "plugin"), { recursive: true })
      await Bun.write(
        path.join(local, "plugin", "probe.ts"),
        `await Bun.write(${JSON.stringify(marker)}, "imported")
export default async function Probe() {
  return {}
}
`,
      )
      await Bun.write(
        path.join(local, "package.json"),
        JSON.stringify({
          scripts: {
            postinstall: `printf installed > ${JSON.stringify(marker)}`,
          },
        }),
      )
      await Bun.write(
        path.join(dir, "openscience.json"),
        JSON.stringify({
          mcp: {
            probe: {
              type: "local",
              command: ["bash", "-lc", `printf mcp > ${JSON.stringify(marker)}`],
            },
          },
          formatter: {
            probe: {
              command: ["bash", "-lc", `printf formatter > ${JSON.stringify(marker)}`],
              extensions: [".txt"],
            },
          },
          lsp: {
            probe: {
              command: ["bash", "-lc", `printf lsp > ${JSON.stringify(marker)}`],
              extensions: [".txt"],
            },
          },
        }),
      )
      await skill(path.join(local, "skill", "project-probe", "SKILL.md"), "project-probe")
      return marker
    },
  })

  await Instance.provide({
    directory: tmp.path,
    fn: () => ProjectTrust.update(Instance.project, { trusted: false }),
  })
  await Instance.disposeAll()

  await Instance.provide({
    directory: tmp.path,
    init: Plugin.init,
    fn: async () => {
      const status = await ProjectTrust.status(Instance.project)
      const visible = await Config.get()
      const executable = await Config.getExecution()
      const skills = await Skill.all()
      const mcps = await MCP.status()

      expect(status.state).toBe("revoked")
      expect(status.source).toBe("persisted")
      expect(status.canExecuteProjectCode).toBe(false)
      expect(status.remediation?.body).toEqual({ trusted: true, root: status.root })
      expect(visible.mcp?.probe).toBeDefined()
      expect(executable.mcp?.probe).toBeUndefined()
      expect(executable.formatter === false ? undefined : executable.formatter?.probe).toBeUndefined()
      expect(executable.lsp === false ? undefined : executable.lsp?.probe).toBeUndefined()
      expect(skills.some((item) => item.name === "project-probe")).toBe(false)
      expect(mcps.probe).toBeUndefined()
    },
  })

  expect(await Bun.file(tmp.extra).exists()).toBe(false)

  await Instance.disposeAll()
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const status = await ProjectTrust.status(Instance.project)
      await ProjectTrust.update(Instance.project, { trusted: true, root: status.root })
    },
  })
  await Instance.disposeAll()
  await Instance.provide({ directory: tmp.path, init: Plugin.init, fn: () => undefined })
  // Trust permits project subprocesses, but a plugin is imported into the host
  // process itself. The OS execution sandbox cannot isolate that import, so the
  // bounded policy refuses it while sandboxing is enabled.
  expect(await Bun.file(tmp.extra).exists()).toBe(false)
})

test("trust is canonical and project-isolated while sandboxed project hooks remain inert", async () => {
  await using _sandbox = await containedExecution()
  await using first = await tmpdir({
    init: async (dir) => {
      const marker = path.join(dir, "hook-ran")
      const plugin = path.join(dir, ".openscience", "plugin", "hook.ts")
      await fs.mkdir(path.dirname(plugin), { recursive: true })
      await fs.mkdir(path.join(dir, ".openscience", "node_modules"), { recursive: true })
      await Bun.write(
        plugin,
        `export default async function Hook() {
  return {
    config: async function () {
      await Bun.write(${JSON.stringify(marker)}, "ran")
    },
  }
}
`,
      )
      return marker
    },
  })
  await using second = await tmpdir()
  const link = path.join(path.dirname(first.path), `${path.basename(first.path)}-link`)
  await fs.symlink(first.path, link)

  const trusted = await Instance.provide({
    directory: first.path,
    fn: async () => {
      const initial = await ProjectTrust.status(Instance.project)
      await expect(
        ProjectTrust.update(Instance.project, {
          trusted: true,
          root: second.path,
        }),
      ).rejects.toBeInstanceOf(ProjectTrust.RootMismatchError)
      return ProjectTrust.update(Instance.project, {
        trusted: true,
        root: initial.root,
      })
    },
  })
  await Instance.disposeAll()

  expect(trusted.state).toBe("trusted")
  expect(trusted.projectID.startsWith("prj_")).toBe(true)

  const alias = await Instance.provide({
    directory: link,
    fn: () => ProjectTrust.status(Instance.project),
  })
  const isolated = await Instance.provide({
    directory: second.path,
    fn: () => ProjectTrust.update(Instance.project, { trusted: false }),
  })
  expect(alias.state).toBe("trusted")
  expect(alias.root).toBe(trusted.root)
  expect(isolated.state).toBe("revoked")
  expect(isolated.source).toBe("persisted")
  expect(isolated.canExecuteProjectCode).toBe(false)
  expect(isolated.projectID).not.toBe(trusted.projectID)

  await Instance.disposeAll()
  await Instance.provide({
    directory: first.path,
    init: Plugin.init,
    fn: () => undefined,
  })
  expect(await Bun.file(first.extra).exists()).toBe(false)

  const revoked = await Instance.provide({
    directory: first.path,
    fn: async () => {
      const status = await ProjectTrust.update(Instance.project, { trusted: false })
      await Instance.dispose()
      return status
    },
  })
  expect(revoked.state).toBe("revoked")

  await Instance.provide({
    directory: first.path,
    init: Plugin.init,
    fn: async () => {
      const executable = await Config.getExecution()
      expect(executable.plugin?.some((item) => item.includes("/hook.ts"))).toBe(false)
    },
  })
  expect(await Bun.file(first.extra).exists()).toBe(false)
})

test("user-global code stays available while project-local skills require trust", async () => {
  const file = path.join(Global.Path.home, ".claude", "skills", "global-probe", "SKILL.md")
  const global = path.dirname(file)
  const plugin = path.join(Global.Path.config, "plugin", "global-probe.ts")
  const marker = path.join(Global.Path.config, "global-probe-ran")
  try {
    await skill(file, "global-probe")
    await fs.mkdir(path.dirname(plugin), { recursive: true })
    await fs.mkdir(path.join(Global.Path.config, "node_modules"), { recursive: true })
    await Bun.write(
      plugin,
      `export default async function GlobalProbe() {
  return {
    config: async function () {
      await Bun.write(${JSON.stringify(marker)}, "ran")
    },
  }
}
`,
    )
    await using tmp = await tmpdir({
      init: async (dir) => {
        await skill(path.join(dir, ".claude", "skills", "local-probe", "SKILL.md"), "local-probe")
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: () => ProjectTrust.update(Instance.project, { trusted: false }),
    })
    await Instance.disposeAll()
    await Instance.provide({
      directory: tmp.path,
      init: Plugin.init,
      fn: async () => {
        const skills = await Skill.all()
        expect(skills.some((item) => item.name === "global-probe")).toBe(true)
        expect(skills.some((item) => item.name === "local-probe")).toBe(false)
      },
    })
    expect(await Bun.file(marker).text()).toBe("ran")
  } finally {
    await fs.rm(global, { recursive: true, force: true })
    await fs.rm(plugin, { force: true })
    await fs.rm(marker, { force: true })
  }
})

test("explicit revocation carries structured remediation without blocking project inspection", async () => {
  await using tmp = await tmpdir()
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      await ProjectTrust.update(Instance.project, { trusted: false })
      const status = await ProjectTrust.status(Instance.project)
      expect(await Config.get()).toBeDefined()
      await expect(ProjectTrust.require(Instance.project, "startup_script")).rejects.toMatchObject({
        data: {
          projectID: Instance.project.id,
          capability: "startup_script",
          remediation: status.remediation,
        },
      })
    },
  })
})

test("revoked startup scripts fail closed before spawning a shell", async () => {
  await using tmp = await tmpdir()
  const marker = path.join(tmp.path, "startup-ran")
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      await ProjectTrust.update(Instance.project, { trusted: false })
      await Project.update({
        projectID: Instance.project.id,
        commands: {
          start: `printf startup > ${JSON.stringify(marker)}`,
        },
      })

      await expect(
        Worktree.runStartScripts(tmp.path, {
          projectID: Instance.project.id,
        }),
      ).rejects.toBeInstanceOf(ProjectTrust.DeniedError)
      expect(await Bun.file(marker).exists()).toBe(false)

      const status = await ProjectTrust.status(Instance.project)
      await ProjectTrust.update(Instance.project, {
        trusted: true,
        root: status.root,
      })
      expect(
        await Worktree.runStartScripts(tmp.path, {
          projectID: Instance.project.id,
        }),
      ).toBe(true)
    },
  })
  expect(await Bun.file(marker).text()).toBe("startup")
})

test("default trust is inspectable, revocable, and restorable through the project permission surface", async () => {
  await using tmp = await tmpdir()
  const project = await Project.fromDirectory(tmp.path)
  const fetch = Server.internalFetch()
  const headers = {
    "content-type": "application/json",
    "x-openscience-project": project.project.id,
  }
  const initial = await fetch(`http://openscience.internal/project/${project.project.id}/trust`, { headers })
  const status = ProjectTrust.Status.parse(await initial.json())

  expect(initial.status).toBe(200)
  expect(status).toMatchObject({
    projectID: project.project.id,
    root: project.project.worktree,
    state: "trusted",
    source: "default",
    canExecuteProjectCode: true,
  })

  const revoked = await fetch(`http://openscience.internal/project/${project.project.id}/trust`, {
    method: "PUT",
    headers,
    body: JSON.stringify({ trusted: false }),
  })
  expect(revoked.status).toBe(200)
  expect(await revoked.json()).toMatchObject({
    state: "revoked",
    canExecuteProjectCode: false,
    remediation: { code: "trust_project_required" },
  })

  const trusted = await fetch(`http://openscience.internal/project/${project.project.id}/trust`, {
    method: "PUT",
    headers,
    body: JSON.stringify({ trusted: true, root: status.root }),
  })
  expect(trusted.status).toBe(200)
  expect(await trusted.json()).toMatchObject({
    state: "trusted",
    canExecuteProjectCode: true,
  })
})
