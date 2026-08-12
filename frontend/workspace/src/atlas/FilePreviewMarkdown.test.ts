import { describe, expect, test } from "bun:test"
import { splitAlignedMarkdown } from "./FilePreviewMarkdown"

describe("Markdown preview alignment blocks", () => {
  test("extracts a leading GitHub-style centered hero for normal Markdown parsing", () => {
    const result = splitAlignedMarkdown(`
<div align="center">

![CI](badge.svg)

<br/>

[![npm](npm.svg)](https://example.com)
[![docs](docs.svg)](https://docs.example.com)

### Research workbench

</div>

---

Body copy.
`)

    expect(result.lead).toEqual({
      alignment: "center",
      text: `![CI](badge.svg)

<p class="atlas-file-badges"><a href="https://example.com"><img src="npm.svg" alt="npm"></a>
<a href="https://docs.example.com"><img src="docs.svg" alt="docs"></a></p>

### Research workbench`,
    })
    expect(result.rest).toBe("---\n\nBody copy.\n")
  })

  test("escapes badge attributes before the sanitized Markdown renderer receives them", () => {
    const result = splitAlignedMarkdown(`<div align="center">
[![A&B](https://img.example/a.svg?x=1&y=2)](https://example.com/?a=1&b=2)
</div>`)

    expect(result.lead?.text).toContain('alt="A&amp;B"')
    expect(result.lead?.text).toContain('src="https://img.example/a.svg?x=1&amp;y=2"')
    expect(result.lead?.text).toContain('href="https://example.com/?a=1&amp;b=2"')
  })

  test("does not reinterpret unsupported or non-leading HTML", () => {
    const unsafe = '<div align="justify">**text**</div>'
    const nested = 'Intro\n\n<div align="center">**text**</div>'

    expect(splitAlignedMarkdown(unsafe)).toEqual({ rest: unsafe })
    expect(splitAlignedMarkdown(nested)).toEqual({ rest: nested })
  })
})
