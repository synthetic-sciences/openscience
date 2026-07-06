import { describe, expect, test } from "bun:test"
import { SessionReview } from "../../src/session/review"

// WS11 — the reviewer gate's runtime spawn hits a real model, so these cover the
// pure decision surface: which turns get reviewed and by whom. The gate() itself
// is a no-op unless config.experimental.reviewGate is set, so the default path
// (off) is exercised implicitly by every other test in the suite staying green.

describe("SessionReview.shouldReview", () => {
  const artifact = "We trained the model in train.py and reached an accuracy of 0.93 on the holdout set. ".repeat(6)

  test("skips non-reviewable agents even with substantive artifact answers", () => {
    expect(SessionReview.shouldReview({ agent: "explore", text: artifact })).toBe(false)
    expect(SessionReview.shouldReview({ agent: "write", text: artifact })).toBe(false)
    expect(SessionReview.shouldReview({ agent: undefined, text: artifact })).toBe(false)
  })

  test("skips trivial short answers from reviewable agents", () => {
    expect(SessionReview.shouldReview({ agent: "research", text: "Done — see above." })).toBe(false)
  })

  test("skips long prose answers with no checkable fact", () => {
    const prose = "This paragraph is entirely prose with no numbers or file references whatsoever. ".repeat(20)
    expect(SessionReview.shouldReview({ agent: "research", text: prose })).toBe(false)
  })

  test("reviews substantive artifact-bearing answers from reviewable agents", () => {
    for (const agent of ["research", "biology", "ml", "physics"]) {
      expect(SessionReview.shouldReview({ agent, text: artifact })).toBe(true)
    }
  })
})

describe("SessionReview.reviewerFor", () => {
  test("maps each domain to its sharpest reviewer", () => {
    expect(SessionReview.reviewerFor("physics")).toBe("physics-critique")
    expect(SessionReview.reviewerFor("research")).toBe("reviewer")
    expect(SessionReview.reviewerFor("biology")).toBe("reviewer")
    expect(SessionReview.reviewerFor("ml")).toBe("reviewer")
    expect(SessionReview.reviewerFor("something-else")).toBe("critique")
  })
})
