import { expect, test } from "bun:test"
import { Command } from "../../src/command"
import { Log } from "../../src/util/log"

Log.init({ print: false })

// The numbered placeholders come out of the template as strings. Ordered as
// text they read $1, $10, $11, $2, which states the order the command fills
// its arguments in differently from the one it actually uses.
test("hints put numbered placeholders in argument order, not text order", () => {
  const numbered = ["$1", "$2", "$3", "$4", "$5", "$6", "$7", "$8", "$9", "$10", "$11"]
  expect(Command.hints([...numbered].reverse().join(" "))).toEqual(numbered)
})

test("hints list a placeholder once and $ARGUMENTS last", () => {
  expect(Command.hints("$ARGUMENTS $2 $1 $2")).toEqual(["$1", "$2", "$ARGUMENTS"])
})
