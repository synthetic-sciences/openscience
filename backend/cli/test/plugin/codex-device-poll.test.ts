import { test, expect } from "bun:test"
import { classifyDevicePollStatus } from "../../src/plugin/codex"

// The device-code poll loop must not abort a whole sign-in on a transient blip.
// Pending (user hasn't approved) and transient (rate-limit / upstream 5xx) both
// keep polling; only a genuine terminal status stops the login.

test("403/404 are pending — keep polling", () => {
  expect(classifyDevicePollStatus(403)).toBe("pending")
  expect(classifyDevicePollStatus(404)).toBe("pending")
})

test("429 and 5xx are transient — keep polling (do not abort)", () => {
  expect(classifyDevicePollStatus(429)).toBe("transient")
  expect(classifyDevicePollStatus(500)).toBe("transient")
  expect(classifyDevicePollStatus(502)).toBe("transient")
  expect(classifyDevicePollStatus(503)).toBe("transient")
})

test("other 4xx are terminal failures", () => {
  expect(classifyDevicePollStatus(400)).toBe("fail")
  expect(classifyDevicePollStatus(401)).toBe("fail")
  expect(classifyDevicePollStatus(410)).toBe("fail")
})
