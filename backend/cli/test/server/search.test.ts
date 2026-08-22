import { expect, test } from "bun:test"
import { Instance } from "../../src/project/instance"
import { Session } from "../../src/session"
import { Storage } from "../../src/storage/storage"
import { SearchRoutes } from "../../src/server/routes/search"
import { tmpdir } from "../fixture/fixture"

test("search matches sessions, messages, bounded workspace text, and artifact files", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const session = await Session.create({ title: "Dose response fits" })
      const messageID = "msg_search_test1"
      await Storage.write(["message", session.id, messageID], {
        id: messageID,
        role: "user",
        sessionID: session.id,
        agent: "research",
        time: { created: Date.now() },
      })
      await Storage.write(["part", messageID, "prt_search_test1"], {
        id: "prt_search_test1",
        messageID,
        sessionID: session.id,
        type: "text",
        text: "Fit a four-parameter logistic curve to the dose response plate data.",
      })
      await Bun.write(`${tmp.path}/results/dose_response.csv`, "dose,response\n1,2\n")
      await Bun.write(`${tmp.path}/notes/protocol.txt`, "The opal-lattice-731 dose protocol is ready.\n")
      await Bun.write(`${tmp.path}/src/dose-model.py`, "print('control')\n")
      await Bun.write(`${tmp.path}/.hidden.txt`, "hidden dose material must not be exposed\n")
      await Bun.write(`${tmp.path}/ignored/private.txt`, "ignored dose material must not be exposed\n")
      await Bun.write(`${tmp.path}/.gitignore`, "ignored/\n")
      await Bun.write(`${tmp.path}/large.txt`, `dose material beyond the preview boundary\n${"x".repeat(70 * 1024)}`)
      await Bun.write(`${tmp.path}/binary.dat`, new Uint8Array([0, 100, 111, 115, 101]))

      const app = SearchRoutes()
      const response = await app.request("/?q=dose")
      const hits = (await response.json()) as Record<string, unknown[]>

      expect(hits.sessions).toContainEqual({ id: session.id, title: "Dose response fits" })
      expect(hits.messages?.[0]).toMatchObject({ sessionID: session.id, messageID, role: "user" })
      expect(String((hits.messages?.[0] as { snippet?: string })?.snippet)).toContain("dose response")
      expect(hits.files).toContainEqual({
        path: "notes/protocol.txt",
        name: "protocol.txt",
        snippet: "The opal-lattice-731 dose protocol is ready.",
      })
      expect(hits.files).not.toContainEqual(expect.objectContaining({ path: "results/dose_response.csv" }))
      expect(hits.files).not.toContainEqual(expect.objectContaining({ path: ".hidden.txt" }))
      expect(hits.files).not.toContainEqual(expect.objectContaining({ path: "ignored/private.txt" }))
      expect(hits.files).not.toContainEqual(expect.objectContaining({ path: "large.txt" }))
      expect(hits.files).not.toContainEqual(expect.objectContaining({ path: "binary.dat" }))
      expect(hits.artifacts).toContainEqual({
        path: "results/dose_response.csv",
        name: "dose_response.csv",
        kind: "dataset",
      })

      const filename = await app.request("/?q=dose-model")
      expect(((await filename.json()) as Record<string, unknown[]>).files).toContainEqual({
        path: "src/dose-model.py",
        name: "dose-model.py",
      })

      const content = await app.request("/?q=opal-lattice-731")
      expect(((await content.json()) as Record<string, unknown[]>).files).toContainEqual({
        path: "notes/protocol.txt",
        name: "protocol.txt",
        snippet: "The opal-lattice-731 dose protocol is ready.",
      })

      const missing = await app.request("/?q=zzznotfound")
      const empty = (await missing.json()) as Record<string, unknown[]>
      expect(empty.sessions).toHaveLength(0)
      expect(empty.messages).toHaveLength(0)
      expect(empty.files).toHaveLength(0)
      expect(empty.artifacts).toHaveLength(0)

      await Session.remove(session.id)
    },
  })
})
