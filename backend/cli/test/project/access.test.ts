import { expect, test } from "bun:test"
import { Agent } from "../../src/agent/agent"
import { Bus } from "../../src/bus"
import { Config } from "../../src/config/config"
import { Instance } from "../../src/project/instance"
import { ProjectAccess } from "../../src/project/access"
import { ProjectTrust } from "../../src/project/trust"
import { PermissionNext } from "../../src/permission/next"
import { Server } from "../../src/server/server"
import { Session } from "../../src/session"
import { SessionPrompt } from "../../src/session/prompt"
import { tmpdir } from "../fixture/fixture"

let accessRouteProbeDisposals = 0
const accessRouteProbe = Instance.state(
  () => ({ token: crypto.randomUUID() }),
  async () => {
    accessRouteProbeDisposals++
  },
)

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

test("project access and trust routes update authority without disposing the active runtime", async () => {
  const previous = await Config.trustedSandbox()
  try {
    await Config.setSandbox({ enabled: true })
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        accessRouteProbeDisposals = 0
        const activeRuntime = accessRouteProbe()
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
        expect(accessRouteProbe()).toBe(activeRuntime)
        expect(accessRouteProbeDisposals).toBe(0)

        const trust = await Server.internalFetch()(`http://openscience.internal/project/${Instance.project.id}/trust`, {
          method: "PUT",
          headers: {
            "content-type": "application/json",
            "x-openscience-project": Instance.project.id,
          },
          body: JSON.stringify({ trusted: false }),
        })
        expect(trust.status).toBe(200)
        expect(accessRouteProbe()).toBe(activeRuntime)
        expect(accessRouteProbeDisposals).toBe(0)
      },
    })
  } finally {
    await Config.setSandbox(previous)
  }
})

test("widening preserves work while a later narrowing refreshes same-turn tool permissions", async () => {
  const previous = await Config.trustedSandbox()
  try {
    await Config.setSandbox({ enabled: true, onUnavailable: "error" })
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const changes: boolean[] = []
        const unsubscribe = Bus.subscribe(ProjectAccess.Event.Changed, (event) => {
          changes.push(event.properties.narrowing)
        })
        try {
          const initial = await ProjectAccess.status(Instance.project)
          const full = await ProjectAccess.update(Instance.project, { mode: "full", root: initial.root })
          const session = await Session.createNext({ directory: Instance.directory })
          const agent = await Agent.get("research")
          if (!agent) throw new Error("Missing Research agent")
          const advertised = PermissionNext.merge(agent.permission, session.permission ?? [])
          expect(PermissionNext.evaluate("websearch", "*", advertised).action).toBe("allow")
          expect(PermissionNext.evaluate("network", "*", advertised).action).toBe("allow")

          const approve = await ProjectAccess.update(Instance.project, { mode: "approve", root: full.root })
          const refreshed = await SessionPrompt.permissionAtExecution({
            agent,
            session,
            authority: full,
            permission: advertised,
          })
          expect(refreshed.authority.revision).toBe(approve.revision)
          expect(PermissionNext.evaluate("websearch", "*", refreshed.permission).action).toBe("allow")
          expect(PermissionNext.evaluate("network", "*", refreshed.permission).action).toBe("ask")
          expect(changes).toEqual([false, true])
        } finally {
          unsubscribe()
        }
      },
    })
  } finally {
    await Config.setSandbox(previous)
  }
})
