import { expect, test } from "bun:test"
import path from "node:path"
import { Instance } from "../../src/project/instance"
import { ProjectTrust } from "../../src/project/trust"
import { Server } from "../../src/server/server"
import { Session } from "../../src/session"
import { tmpdir } from "../fixture/fixture"

test("the legacy session shell route requires trust and keeps writes inside its sandbox", async () => {
  await using workspace = await tmpdir()
  await using outside = await tmpdir()
  const state = await Instance.provide({
    directory: workspace.path,
    fn: async () => ({ projectID: Instance.project.id, session: await Session.create({ title: "shell route" }) }),
  })
  const target = path.join(outside.path, "escaped")
  const fetch = Server.internalFetch()
  const invoke = () =>
    fetch(
      `http://openscience.internal/session/${state.session.id}/shell?directory=${encodeURIComponent(workspace.path)}`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-openscience-project": state.projectID,
        },
        body: JSON.stringify({
          agent: "research",
          model: { providerID: "test", modelID: "test" },
          command: `printf escaped > ${JSON.stringify(target)}`,
        }),
      },
    )

  const denied = await invoke()
  expect(denied.status).toBe(403)
  expect(await denied.json()).toMatchObject({ name: "ExecutionAuthorityDeniedError" })
  expect(await Bun.file(target).exists()).toBe(false)

  await Instance.provide({
    directory: workspace.path,
    fn: async () => {
      const status = await ProjectTrust.status(Instance.project)
      await ProjectTrust.update(Instance.project, { trusted: true, root: status.root })
    },
  })
  const confined = await invoke()
  expect(confined.status).toBe(200)
  expect(await Bun.file(target).exists()).toBe(false)

  await Instance.provide({
    directory: workspace.path,
    fn: () => Session.remove(state.session.id),
  })
}, 30_000)
