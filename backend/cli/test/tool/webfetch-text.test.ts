import { describe, expect, test } from "bun:test"
import { extractTextFromHTML } from "../../src/tool/webfetch"

describe("extractTextFromHTML", () => {
  test("resumes text after a skipped element ends", async () => {
    const text = await extractTextFromHTML("<p>Total is 42.<script>x</script> See appendix B for details.</p>")
    expect(text).toBe("Total is 42. See appendix B for details.")
  })

  test("resumes text after a skipped element inside a block", async () => {
    const text = await extractTextFromHTML("<div>before<style>.a{color:red}</style>after</div>")
    expect(text).toBe("beforeafter")
  })

  test("keeps a stylesheet in the head from affecting the body prose", async () => {
    const text = await extractTextFromHTML(
      "<html><head><style>body{color:red}</style></head><body><h1>Results</h1><p>All samples passed.</p></body></html>",
    )
    expect(text).toContain("Results")
    expect(text).toContain("All samples passed.")
    expect(text).not.toContain("color:red")
  })

  test("skips markup nested inside a skipped element", async () => {
    const text = await extractTextFromHTML("<p>Before.</p><noscript><p>enable scripting</p></noscript><p>After.</p>")
    expect(text).not.toContain("enable scripting")
    expect(text).toContain("Before.")
    expect(text).toContain("After.")
  })

  test("keeps script and style content out of the result", async () => {
    const text = await extractTextFromHTML("<div><script>var a = 1</script><style>.a{}</style><iframe>frame</iframe>Text.</div>")
    expect(text).toBe("Text.")
  })
})