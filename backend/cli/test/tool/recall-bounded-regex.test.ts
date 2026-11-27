import { expect, test } from "bun:test"
import { boundedRegexWidth } from "../../src/tool/recall-regex-width"

test("only positively bounded, context-independent /gi sequences opt into full search", () => {
  for (const [regex, max] of [
    [/SEAL-\d{2}/gi, 7],
    [/RUN-[A-Z]{2,8}/gi, 12],
    [/LOT_[0-9A-F]{4}-\w{3}/gi, 12],
    [/r[\s\S]z/gi, 3],
    [/abc/gi, 3],
    [/\u1234/gi, 1],
    [new RegExp("\\u94dc\\u724c-\\d{2}", "gi"), 5],
  ] as const)
    expect(boundedRegexWidth(regex)).toBe(max)
  for (const regex of [
    /BEGIN.*END/gi,
    /^SEAL/gi,
    /SEAL$/gi,
    /\bseal/gi,
    /(?=abc)/gi,
    /(a)\1/gi,
    /A|BB/gi,
    /a{0,3}/gi,
    /a{2,}/gi,
    /\u{1F600}/giu,
    /a{2,3}b{1,4}/gi,
    /[ab]{4097}/gi,
    /a/giu,
    /SEAL/gy,
  ])
    expect(boundedRegexWidth(regex)).toBeUndefined()
})
