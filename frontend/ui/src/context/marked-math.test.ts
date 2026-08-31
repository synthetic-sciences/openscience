import { describe, expect, test } from "bun:test"
import { Marked } from "marked"
import { parseMarkdown } from "./marked"
import { sanitize } from "../components/markdown"

const document = (html: string) => new DOMParser().parseFromString(html, "text/html")
const equations = (html: string) => [...document(html).querySelectorAll("annotation")].map((node) => node.textContent)

describe("Markdown math in the production parser", () => {
  test("renders TeX parenthesis/bracket and existing dollar delimiters without losing commands", async () => {
    const html = await parseMarkdown(String.raw`Use \(\alpha \in \{0,.25,.5\}\) and $\beta$.

\[
W_l(\alpha) = (1-\alpha)W_l^{base} + \alpha W_l^{edit}
\]

$$
E = mc^2
$$`)
    expect(equations(html)).toEqual([
      String.raw`\alpha \in \{0,.25,.5\}`,
      String.raw`\beta`,
      String.raw`W_l(\alpha) = (1-\alpha)W_l^{base} + \alpha W_l^{edit}`,
      "E = mc^2",
    ])
    expect(document(html).querySelectorAll(".katex-display")).toHaveLength(2)
  })

  test("recognizes display math adjacent to prose, in lists, and quoted passages", async () => {
    const html = await parseMarkdown(String.raw`Result follows:
\[x^2\]
Next paragraph.

- Estimate \(\beta\).
- Compare \[x+y\] here.

> \[z=1\]`)
    expect(equations(html)).toEqual(["x^2", String.raw`\beta`, "x+y", "z=1"])
    expect(document(html).querySelectorAll("li")).toHaveLength(2)
    expect(document(html).querySelector("blockquote .katex-display")).not.toBeNull()
  })

  test("preserves code, escaped delimiters, literal brackets, prices and HTML attributes", async () => {
    const html = await parseMarkdown(
      String.raw`Inline code: \`\(x\)\`.

~~~text
\[literal fenced math\]
$literal$
~~~

    \[indented code\]

Escaped \\(not math\\), brackets [ordinary text], prices $5 and $20.

<code>\(literal\) $literal$</code> <kbd>\[literal\]</kbd>

<span title="\(literal\)">Attribute is unchanged.</span>

[A link](https://example.com/path "\(literal\)")`.replaceAll("\\`", "`"),
    )
    expect(equations(html)).toEqual([])
    const dom = document(html)
    expect(dom.querySelectorAll("pre")).toHaveLength(2)
    expect(dom.querySelector("code")?.textContent).toBe(String.raw`\(x\)`)
    expect(dom.body.textContent).toContain("prices $5 and $20")
    expect(dom.querySelector("span[title]")?.getAttribute("title")).toBe(String.raw`\(literal\)`)
    expect(dom.querySelector("a")?.getAttribute("href")).toBe("https://example.com/path")
  })

  test("leaves incomplete streaming equations readable and renders them once closed", async () => {
    const source = String.raw`Result \(\alpha + \beta`
    const incomplete = await parseMarkdown(source)
    expect(equations(incomplete)).toEqual([])
    expect(document(incomplete).body.textContent).toContain(String.raw`\alpha + \beta`)
    expect(equations(await parseMarkdown(source + String.raw`\)`))).toEqual([String.raw`\alpha + \beta`])
    expect(equations(await parseMarkdown(String.raw`\[unfinished`))).toEqual([])
    expect(equations(await parseMarkdown(String.raw`\[finished\]`))).toEqual(["finished"])
  })

  test("never treats TeX commands as trusted HTML and preserves sanitized MathML", async () => {
    const html = sanitize(
      await parseMarkdown(String.raw`\(\href{javascript:alert(1)}{unsafe}\)

\[x < y\]

<script>alert('unsafe')</script>`),
    )
    const dom = document(html)
    expect(dom.querySelector("script")).toBeNull()
    expect(dom.querySelector('[href^="javascript:"]')).toBeNull()
    expect(dom.querySelector("math semantics annotation")?.textContent).toBe(
      String.raw`\href{javascript:alert(1)}{unsafe}`,
    )
    expect(dom.querySelectorAll(".katex")).toHaveLength(2)
  })

  test("uses original Markdown for math even when a host supplies an escape-consuming native parser", async () => {
    const native = new Marked()
    const parse = async (source: string) => `<section data-native="true">${await native.parse(source)}</section>`
    expect(await parseMarkdown("Plain text", parse)).toContain('data-native="true"')
    const html = await parseMarkdown(String.raw`\(\beta\) and $x$.`, parse)
    expect(equations(html)).toEqual([String.raw`\beta`, "x"])
    expect(html).not.toContain('data-native="true"')
  })

  test("a literal escaped closing delimiter does not prematurely end an equation", async () => {
    const html = await parseMarkdown(String.raw`\(a \\) + b\)`)
    expect(equations(html)).toEqual([String.raw`a \\) + b`])
  })

  test("unfinished delimiters do not swallow a later complete equation", async () => {
    const source = String.raw`\( `.repeat(2000) + String.raw`\(x\)`
    const html = await parseMarkdown(source)
    expect(equations(html)).toEqual(["x"])
    expect(document(html).body.textContent?.startsWith("( ( (")).toBe(true)
  })

  test.each(["Costs $5 and $20.", "Costs $-5 and $20.", "Costs $.50 and $20.", "Costs $5 and $-20."])(
    "leaves ordinary price pairs literal: %s",
    async (source) => {
      const html = await parseMarkdown(source)
      expect(equations(html)).toEqual([])
      expect(document(html).body.textContent?.trim()).toBe(source)
    },
  )
})
