import { expect, test } from "bun:test"
import { base64Encode } from "@synsci/util/encode"
import { decode64 } from "./base64"

test("decodes a legacy base64 directory segment", () => {
  expect(decode64(base64Encode("/home/keertan/rsi"))).toBe("/home/keertan/rsi")
})

test("decodes a legacy base64 windows directory segment", () => {
  expect(decode64(base64Encode("C:\\Users\\keertan\\rsi"))).toBe("C:\\Users\\keertan\\rsi")
})

// An opaque token in the first URL segment (share link, stale bookmark) is often
// valid base64. Decoding it yields binary junk that the server then resolved
// against its cwd and registered as a brand new project.
test("rejects a segment that decodes to bytes which are not a path", () => {
  expect(decode64("9tQx1Zk2Lp7RvB0cNaWfEjHsUyTgOiMd")).toBeUndefined()
})

test("rejects a segment that decodes to a relative path", () => {
  expect(decode64(base64Encode("hello-world"))).toBeUndefined()
})

test("rejects a segment that is not base64 at all", () => {
  expect(decode64("not base64!!")).toBeUndefined()
})
