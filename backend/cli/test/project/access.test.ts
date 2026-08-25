import { expect, test } from "bun:test"
import { Config } from "../../src/config/config"
import { Instance } from "../../src/project/instance"
import { ProjectAccess } from "../../src/project/access"
import { ProjectTrust } from "../../src/project/trust"
import { Server } from "../../src/server/server"
import { tmpdir } from "../fixture/fixture"

test("action access is atomic and isolated to its owning project", async () => {
  const previous = await Config.trustedSandbox()
  try {
    await Config.setSandbox({ enabled: true, onUnavailable: "error" })
    await using first = await tmpdir({ git: true })
    await using second = await tmpdir({ git: true })

    const full = await Instance.provide({
      directory: first.path,
      fn: async () => {
        const initial = await ProjectAccess.status(Instance.project)
        expect(initial).toMatchObject({ mode: "approve", source: "default", sandbox: { enabled: true } })
        return ProjectAccess.update(Instance.project, { mode: "full", root: initial.root })
      },
    })
    expect(full).toMatchObject({ mode: "full", requestedMode: "full", sandbox: { enabled: false } })

    await Instance.provide({
      directory: second.path,
      fn: async () => {
        expect(await ProjectAccess.status(Instance.project)).toMatchObject({
          mode: "approve",
          sandbox: { enabled: true },
        })
      },
    })

    await Instance.provide({
      directory: first.path,
      fn: async () => {
        const ask = await ProjectAccess.update(Instance.project, { mode: "ask" })
        expect(ask).toMatchObject({ mode: "ask", requestedMode: "ask", trusted: false })
        expect((await ProjectTrust.status(Instance.project)).canExecuteProjectCode).toBe(false)
      },
    })
  } finally {
    await Config.setSandbox(previous)
  }
})

test("project access route updates one project without machine-wide sandbox writes", async () => {
  const previous = await Config.trustedSandbox()
  try {
    await Config.setSandbox({ enabled: true })
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const initial = await ProjectAccess.status(Instance.project)
        const response = await Server.internalFetch()(
          `http://openscience.internal/project/${Instance.project.id}/access`,
          {
            method: "PUT",
            headers: {
              "content-type": "application/json",
              "x-openscience-project": Instance.project.id,
            },
            body: JSON.stringify({ mode: "full", root: initial.root }),
          },
        )
        expect(response.status).toBe(200)
        expect(ProjectAccess.Status.parse(await response.json())).toMatchObject({
          projectID: Instance.project.id,
          mode: "full",
          sandbox: { enabled: false },
        })
        expect(await Config.trustedSandbox()).toMatchObject({ enabled: true })
      },
    })
  } finally {
    await Config.setSandbox(previous)
  }
})
