import { afterEach, expect, test } from "bun:test"
import type { PluginInput } from "@synsci/plugin"
import { RedirectUnit, REDIRECT_MESSAGE } from "../../../src/harness/redirect"
import { HarnessState } from "../../../src/harness/state"

const input = {} as PluginInput

afterEach(() => HarnessState.reset())

test("the first guard trip in a session is a redirect; the second is a stop", async () => {
  const unit = await RedirectUnit(input)
  const first = { message: undefined as string | undefined }
  await unit["loop.guard"]!({ sessionID: "ses_a", kind: "tool_errors", tool: "bash", trips: 1 }, first)
  expect(first.message).toBe(REDIRECT_MESSAGE)
  const second = { message: undefined as string | undefined }
  await unit["loop.guard"]!({ sessionID: "ses_a", kind: "text_loop", trips: 1 }, second)
  expect(second.message).toBeUndefined()
  // Another session is not affected by the first one's trips.
  const other = { message: undefined as string | undefined }
  await unit["loop.guard"]!({ sessionID: "ses_b", kind: "output_stall", trips: 1 }, other)
  expect(other.message).toBe(REDIRECT_MESSAGE)
})

test("a finished turn resets the trip count so the next request gets its own redirect", async () => {
  const unit = await RedirectUnit(input)
  await unit["loop.guard"]!(
    { sessionID: "ses_a", kind: "tool_errors", tool: "python", trips: 1 },
    { message: undefined },
  )
  await unit.event!({ event: { type: "session.idle", properties: { sessionID: "ses_a" } } })
  const again = { message: undefined as string | undefined }
  await unit["loop.guard"]!({ sessionID: "ses_a", kind: "tool_errors", tool: "python", trips: 1 }, again)
  expect(again.message).toBe(REDIRECT_MESSAGE)
})
