import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { PermissionNext } from "../../src/permission/next"
import { Instance } from "../../src/project/instance"
import { Session } from "../../src/session"
import { SessionPrompt } from "../../src/session/prompt"
import { Provider } from "../../src/provider/provider"
import { tmpdir, trustProject } from "../fixture/fixture"
import { STRESS_PROVIDER_ID, STRESS_PROVIDER_MODEL, stressProviderConfig } from "../fixture/stress-provider"

test("/stop cancels a prompt that is waiting on an attachment permission card", async () => {
  // The provider is never reached: the prompt is stopped while it prepares.
  await using project = await tmpdir({ git: true, config: stressProviderConfig("http://127.0.0.1:9/v1") })
  await using outside = await tmpdir()
  const attachment = path.join(outside.path, "notes.txt")
  await fs.writeFile(attachment, "outside the project")
  await Instance.provide({
    directory: project.path,
    init: async () => {
      await trustProject()
      await Provider.invalidate()
    },
    fn: async () => {
      const session = await Session.create({ title: "submit stop" })
      // The route's entry point: no turn is running, so the prompt takes the
      // cancellation reservation before it starts preparing.
      const submitted = SessionPrompt.submit({
        sessionID: session.id,
        model: { providerID: STRESS_PROVIDER_ID, modelID: STRESS_PROVIDER_MODEL },
        agent: "research",
        delegation: false,
        parts: [
          { type: "text", text: "Read the attached notes." },
          { type: "file", url: `file://${attachment}`, filename: "notes.txt", mime: "text/plain" },
        ],
      })
      const deadline = Date.now() + 10_000
      while ((await PermissionNext.list()).length === 0) {
        if (Date.now() > deadline) throw new Error("no permission card was raised for the outside attachment")
        await Bun.sleep(20)
      }
      expect((await PermissionNext.list()).map((request) => request.sessionID)).toEqual([session.id])

      SessionPrompt.cancel(session.id)
      await expect(submitted).rejects.toThrow()
      expect(await PermissionNext.list()).toEqual([])
    },
  })
}, 30_000)
