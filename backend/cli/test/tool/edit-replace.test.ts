import { expect, test } from "bun:test"
import { replace } from "../../src/tool/edit"

test("replaceAll writes the replacement literally, including $ sequences", () => {
  // Shell scripts, Makefiles, LaTeX and Perl all use `$$`; `$&` would have
  // pasted the matched text back in and `$'` the rest of the file.
  expect(replace("echo pid\necho pid\n", "echo pid", "echo $$ && echo '$&'", true)).toBe(
    "echo $$ && echo '$&'\necho $$ && echo '$&'\n",
  )
  const literal = "$$ $& $` $' x"
  expect(replace("a\na\n", "a", literal, true)).toBe(`${literal}\n${literal}\n`)
})

test("single replacement is unchanged and still literal", () => {
  expect(replace("price\n", "price", "cost $$", false)).toBe("cost $$\n")
})

test("a fuzzy line match keeps the indentation it matched", () => {
  // Models routinely re-quote a line with normalised internal spacing. That
  // single divergence hands the edit to the whole-line branch, and the
  // replacement was written for the text the model quoted, not the padding it
  // never saw — so substituting it deletes the indentation.
  const file = [
    "class A:",
    "    def run(self):",
    "        if self.ok:",
    "            return x",
    "",
    "class B:",
    "    pass",
    "",
  ].join("\n")
  expect(replace(file, "return  x", "return 42")).toBe(
    [
      "class A:",
      "    def run(self):",
      "        if self.ok:",
      "            return 42",
      "",
      "class B:",
      "    pass",
      "",
    ].join("\n"),
  )
})

test("an explicit de-indent is still applied", () => {
  // The guard must compare against what the model quoted, not against the
  // replacement, or a deliberate outdent would be refused.
  const file = "def f():\n    if a:\n        return x\n"
  expect(replace(file, "        return x", "    return x")).toBe("def f():\n    if a:\n    return x\n")
})

test("an indented line quoted with its indentation is replaced exactly", () => {
  const file = "def f():\n    if a:\n        return x\n"
  expect(replace(file, "        return x", "        return 42")).toBe("def f():\n    if a:\n        return 42\n")
})

test("a multi-line block quoted at column 0 keeps every line at the file's depth", () => {
  // Stripping the whole candidate would land the first line at the file's 8
  // spaces and leave the rest at the 4 the model wrote, which is an
  // IndentationError in Python. The padding has to reach the second line too.
  const file = ["        def f():", "            return 1", ""].join("\n")
  expect(replace(file, "def f():\n    return 1", "def f():\n    return 2")).toBe(
    ["        def f():", "            return 2", ""].join("\n"),
  )
})

test("a partly-indented line lands back at the file's depth", () => {
  // Quoted at 4 and matched at 12, with the internal spacing normalised on the
  // way in so the exact search misses. Only the 8 spaces the matcher added
  // belong to the file, so the replacement's own 4 has to land at 12 rather
  // than stacking on top of a search that had already given up the padding.
  const file = ["def f():", "    if a:", "            return  x", ""].join("\n")
  expect(replace(file, "    return x", "    return 42")).toBe(
    ["def f():", "    if a:", "            return 42", ""].join("\n"),
  )
})
