import assert from "node:assert/strict"
import { describe, test } from "node:test"
import { createOpenScienceClient } from "../src/v2/client.js"

describe("createOpenScienceClient", () => {
  test("asks every request for JSON so an unknown route cannot answer with the UI shell", async () => {
    const requests: Request[] = []
    const client = createOpenScienceClient({
      baseUrl: "http://client.test",
      projectID: "prj_test",
      fetch: async (input) => {
        const request = input instanceof Request ? input : new Request(input)
        requests.push(request)
        return Response.json({ healthy: true, version: "test" })
      },
    })
    await client.global.health()
    assert.equal(requests.length, 1)
    assert.equal(requests[0]!.headers.get("accept"), "application/json")
    assert.equal(requests[0]!.headers.get("x-openscience-project"), "prj_test")
  })

  test("an explicit Accept header still wins", async () => {
    const requests: Request[] = []
    const client = createOpenScienceClient({
      baseUrl: "http://client.test",
      headers: { accept: "text/event-stream" },
      fetch: async (input) => {
        const request = input instanceof Request ? input : new Request(input)
        requests.push(request)
        return Response.json({ healthy: true, version: "test" })
      },
    })
    await client.global.health()
    assert.equal(requests[0]!.headers.get("accept"), "text/event-stream")
  })
})
