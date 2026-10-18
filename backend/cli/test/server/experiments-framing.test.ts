import { afterEach, expect, test } from "bun:test"
import { Experiments } from "../../src/experiments"
import { Instance } from "../../src/project/instance"
import { ExperimentsRoutes } from "../../src/server/routes/experiments"
import { tmpdir } from "../fixture/fixture"

afterEach(() => Experiments.close())

test("study framing API validates updates, preserves omitted fields and renders the ledger", async () => {
  await using tmp = await tmpdir()
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const study = await Experiments.createStudy({
        sessionID: "ses_frame",
        name: "Trial",
        purpose: "Measure loss",
        question: "Does momentum help?",
        metric: "loss",
        direction: "minimize",
        root: tmp.path,
      })
      const route = ExperimentsRoutes()
      const patch = (body: unknown, id = study.id) =>
        route.request(`/studies/${id}`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        })
      const response = await patch({ hypothesis: "Momentum reduces loss." })
      expect(response.status).toBe(200)
      expect(await response.json()).toMatchObject({
        question: "Does momentum help?",
        hypothesis: "Momentum reduces loss.",
      })
      expect(await Bun.file(`${tmp.path}/study.md`).text()).toContain("Momentum reduces loss.")
      expect((await patch({})).status).toBe(400)
      expect((await patch({ hypothesis: "x".repeat(4001) })).status).toBe(400)
      expect((await patch({ question: "hello", status: "running" })).status).toBe(400)
      expect((await patch({ question: "hello" }, "study_missing")).status).toBe(404)
    },
  })
})
