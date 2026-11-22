import { expect, test } from "bun:test"
import { retry } from "../../../../tooling/util/src/retry"

test("retries transient fetch failed errors from Node fetch", async () => {
  let calls = 0
  const response = await retry(
    async () => {
      calls++
      if (calls < 3) throw new TypeError("fetch failed")
      return "ok"
    },
    { attempts: 3, delay: 0 },
  )
  expect(response).toBe("ok")
  expect(calls).toBe(3)
})

test("still stops after the first non-transient error", async () => {
  let calls = 0
  await expect(
    retry(
      async () => {
        calls++
        throw new Error("invalid session JSON")
      },
      { attempts: 3, delay: 0 },
    ),
  ).rejects.toThrow("invalid session JSON")
  expect(calls).toBe(1)
})
