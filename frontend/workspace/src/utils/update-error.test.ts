import { describe, expect, test } from "bun:test"
import { updateError } from "./update-error"

describe("desktop update errors", () => {
  test("shows the direct update service error", () => {
    expect(updateError({ error: "The downloaded update failed verification" }, 409)).toBe(
      "The downloaded update failed verification",
    )
  })

  test("unwraps legacy server errors instead of showing only status 500", () => {
    expect(
      updateError(
        {
          name: "UnknownError",
          data: {
            message:
              "Error: Automatic updates are unavailable for this installation.\n    at createUpdateInstaller (updates.ts:50)",
          },
        },
        500,
      ),
    ).toBe("Automatic updates are unavailable for this installation.")
  })

  test("falls back when the response is not structured JSON", () => {
    expect(updateError(undefined, 502)).toBe("Update install failed (502)")
  })
})
