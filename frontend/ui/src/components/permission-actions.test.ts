import { describe, expect, test } from "bun:test"
import { formatApprovalBytes } from "./permission-actions"

describe("formatApprovalBytes", () => {
  test("promotes a rounded KB value instead of labelling it 1024 KB", () => {
    // The branch tested the raw byte count but printed a rounded one, so the
    // unit contradicted the exact count beside it.
    expect(formatApprovalBytes(1_048_575)).toBe("1 MB (1,048,575 bytes)")
    expect(formatApprovalBytes(1_048_500)).toBe("1023.9 KB (1,048,500 bytes)")
    expect(formatApprovalBytes(1_048_576)).toBe("1 MB (1,048,576 bytes)")
  })

  test("switches units at the byte where the rounded value would read 1024", () => {
    // 1,048,525 is the first byte count whose one-decimal KB form is 1024.0.
    expect(formatApprovalBytes(1_048_524)).toBe("1023.9 KB (1,048,524 bytes)")
    expect(formatApprovalBytes(1_048_525)).toBe("1 MB (1,048,525 bytes)")
  })

  test("keeps the exact count and ordinary unit boundaries", () => {
    expect(formatApprovalBytes(0)).toBe("0 bytes")
    expect(formatApprovalBytes(1023)).toBe("1,023 bytes")
    expect(formatApprovalBytes(1024)).toBe("1 KB (1,024 bytes)")
    expect(formatApprovalBytes(1_048_400)).toBe("1023.8 KB (1,048,400 bytes)")
  })

  test("reports a size it cannot count as unknown rather than as text", () => {
    // The finite check ran after the count had already been formatted, so
    // these reached the label as "NaN bytes" and "∞ bytes".
    expect(formatApprovalBytes(NaN)).toBe("unknown size")
    expect(formatApprovalBytes(Infinity)).toBe("unknown size")
  })

  test("a negative size is not rendered", () => {
    expect(formatApprovalBytes(-5)).toBe("0 bytes")
  })
})
