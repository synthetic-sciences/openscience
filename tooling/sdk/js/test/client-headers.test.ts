import assert from "node:assert/strict"
import { describe, test } from "node:test"
import { createOpenScienceClient } from "../src/v2/client.js"
import { createOpenScienceClient as createV1Client } from "../src/client.js"

describe("x-openscience-directory", () => {
  const directory = "C:\\Users\\Пользователь\\AppData\\Roaming\\@synsci\\desktop\\workspace"

  test("v1 client percent-encodes a non-ASCII directory instead of throwing", async () => {
    const requests: Request[] = []
    const client = createV1Client({
      baseUrl: "http://client.test",
      directory,
      fetch: async (input) => {
        const request = input instanceof Request ? input : new Request(input)
        requests.push(request)
        return Response.json({})
      },
    })
    await client.project.current()
    const header = requests[0]!.headers.get("x-openscience-directory")!
    assert.equal(decodeURIComponent(header), directory)
  })

  test("v1 client sends an ASCII directory unchanged", async () => {
    const requests: Request[] = []
    const client = createV1Client({
      baseUrl: "http://client.test",
      directory: "C:\\work\\project",
      fetch: async (input) => {
        const request = input instanceof Request ? input : new Request(input)
        requests.push(request)
        return Response.json({})
      },
    })
    await client.project.current()
    assert.equal(requests[0]!.headers.get("x-openscience-directory"), "C:\\work\\project")
  })
})

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
