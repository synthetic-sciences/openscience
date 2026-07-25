import { expect, test } from "bun:test"
import DOMPurify from "dompurify"

test("sanitizes every node after removals during traversal", () => {
  const safe = DOMPurify.sanitize(
    "<img src=x onerror=alert(1)><img src=y onerror=alert(2)><script>evil()</script><p onclick=alert(3)>safe</p>",
  )

  expect(safe).not.toContain("onerror")
  expect(safe).not.toContain("onclick")
  expect(safe).not.toContain("<script")
  expect(safe).toContain("<p>safe</p>")
})
