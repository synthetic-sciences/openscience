import assert from "node:assert/strict"
import { test } from "node:test"
import { createOpenScienceClient } from "../src/v2/client.js"

test("review settings retain the published get and set client contract", async () => {
  const requests: Request[] = []
  const client = createOpenScienceClient({
    baseUrl: "http://review.test",
    fetch: async (input) => {
      const request = input instanceof Request ? input : new Request(input)
      requests.push(request)
      return Response.json({ auto: request.method === "PUT", model: null })
    },
  })

  await client.settings.review.get()
  await client.settings.review.set({ auto: true, model: null })

  assert.equal(requests[0]?.url, "http://review.test/settings/review")
  assert.equal(requests[0]?.method, "GET")
  assert.equal(requests[1]?.url, "http://review.test/settings/review")
  assert.equal(requests[1]?.method, "PUT")
  assert.deepEqual(await requests[1]?.json(), { auto: true, model: null })
})
