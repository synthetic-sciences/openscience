import { expect, test } from "bun:test"
import { Instance } from "../../src/project/instance"
import { Server } from "../../src/server/server"
import { Session } from "../../src/session"
import { tmpdir } from "../fixture/fixture"

test("sending to an unknown session or model answers with a status, not an empty 200", async () => {
  await using tmp = await tmpdir()
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const fetch = Server.internalFetch()
      const directory = `?directory=${encodeURIComponent(tmp.path)}`
      const missing = await fetch(
        `http://openscience.internal/session/ses_does_not_exist0000000000/message${directory}`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ parts: [{ type: "text", text: "hi" }] }),
        },
      )
      expect(missing.status).toBe(404)
      expect(await missing.json()).toMatchObject({ name: "NotFoundError" })

      const session = await Session.create({})
      const model = await fetch(`http://openscience.internal/session/${session.id}/message${directory}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: { providerID: "nope", modelID: "missing" },
          parts: [{ type: "text", text: "hi" }],
        }),
      })
      expect(model.status).toBe(400)
      expect(await model.json()).toMatchObject({ name: "ProviderModelNotFoundError" })
      await Session.remove(session.id)
    },
  })
})
