import { describe, expect, test } from "bun:test"
import { notebookHtml, notebookImage, notebookOutputs, parseComputationalMarkdown, parseNotebook } from "./notebook"

describe("notebook documents", () => {
  test("preserves multiline cells, raw content, kernel language, and actual execution counts", () => {
    const result = parseNotebook(
      JSON.stringify({
        nbformat: 4,
        metadata: { kernelspec: { name: "ir" } },
        cells: [
          {
            cell_type: "markdown",
            source: ["# Intro\n", "Details"],
            attachments: { "plot.png": { "image/png": "aGVsbG8=" } },
          },
          {
            cell_type: "code",
            source: "1 + 1",
            execution_count: 9,
            outputs: [{ output_type: "execute_result", data: { "text/plain": ["2"] } }],
          },
          { cell_type: "raw", source: "Unprocessed content" },
        ],
      }),
    )
    expect(result.error).toBeUndefined()
    expect(result.cells.map((cell) => [cell.type, cell.source, cell.language, cell.count])).toEqual([
      ["markdown", "# Intro\nDetails", "r", undefined],
      ["code", "1 + 1", "r", 9],
      ["raw", "Unprocessed content", "r", undefined],
    ])
    expect(result.cells[1].outputs).toEqual([{ kind: "text", text: "2" }])
    expect(notebookImage(result.cells[0].attachments?.["plot.png"])).toBe("data:image/png;base64,aGVsbG8=")
  })

  test.each([
    "{",
    "{}",
    '{"nbformat":3,"worksheets":[]}',
    '{"nbformat":4,"cells":[{"cell_type":"code","source":[42]}]}',
  ])("reports unsupported or malformed notebooks instead of silently losing cells: %s", (text) => {
    expect(parseNotebook(text).error).toContain("could not be previewed")
    expect(parseNotebook(text).cells).toEqual([])
  })

  test("renders MIME alternatives once, preserves stderr and tracebacks, and strips terminal control codes", () => {
    expect(
      notebookOutputs([
        { output_type: "display_data", data: { "image/png": ["aGVs\n", "bG8="], "text/plain": "<Figure>" } },
        { output_type: "stream", name: "stderr", text: ["Warning\n"] },
        { output_type: "error", ename: "ValueError", evalue: "bad", traceback: ["\u001b[31mValueError: bad\u001b[0m"] },
        { output_type: "execute_result", data: { "text/html": ["<table></table>"], "text/plain": "table" } },
      ]),
    ).toEqual([
      { kind: "image", src: "data:image/png;base64,aGVsbG8=" },
      { kind: "text", text: "Warning\n" },
      { kind: "error", text: "ValueError: bad" },
      { kind: "html", text: "<table></table>" },
    ])
    expect(notebookHtml("<script>alert(1)</script>")).toContain("default-src 'none'")
    expect(notebookImage({ "image/png": "javascript:alert(1)" })).toBeUndefined()
  })

  test("splits R Markdown and Quarto chunks, retains YAML and prose, and respects nested fences", () => {
    const result = parseComputationalMarkdown(
      "---\r\ntitle: Report\r\n---\r\n# Study\r\n\r\n```{r setup, echo=FALSE}\r\nx <- 41\r\n```\r\n\r\n~~~{python}\r\n#| label: result\r\nx + 1\r\n~~~\r\n\r\n````markdown\r\n```{r}\r\nnot_a_chunk()\r\n```\r\n````",
    )
    expect(result.cells.map((cell) => cell.type)).toEqual(["raw", "markdown", "code", "code", "markdown"])
    expect(result.cells[0].source).toBe("title: Report")
    expect(result.cells[2]).toMatchObject({ language: "r", label: "setup", source: "x <- 41" })
    expect(result.cells[3]).toMatchObject({ language: "python", source: "#| label: result\nx + 1" })
    expect(result.cells[4].source).toContain("not_a_chunk()")
  })

  test("leaves unclosed fences as visible Markdown and preserves unsupported chunk languages", () => {
    expect(parseComputationalMarkdown("```{r}\nx <- 1").cells[0]).toMatchObject({
      type: "markdown",
      source: "```{r}\nx <- 1",
    })
    expect(parseComputationalMarkdown("```{julia}\nx = 1\n```").cells[0]).toMatchObject({
      type: "code",
      language: "julia",
    })
  })
})
