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
