import { expect, test } from "bun:test"
import { detectImageMime, readImageDimensions } from "../../src/util/image"

const validPNG = () => {
  const bytes = new Uint8Array(24)
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  bytes.set([0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52], 8) // IHDR
  bytes[19] = 16 // width
  bytes[23] = 24 // height
  return bytes
}

test("accepts PNG dimensions only with the signature and IHDR chunk", () => {
  expect(detectImageMime(validPNG())).toBe("image/png")
  expect(readImageDimensions(validPNG())).toEqual({ width: 16, height: 24 })
  const wrongSignature = validPNG()
  wrongSignature[4] = 0 // not the mandatory PNG signature
  expect(detectImageMime(wrongSignature)).toBeUndefined()
  expect(readImageDimensions(wrongSignature)).toBeUndefined()
  const wrongHeader = validPNG()
  wrongHeader[12] = 0 // not IHDR
  expect(readImageDimensions(wrongHeader)).toBeUndefined()
  const zeroWidth = validPNG()
  zeroWidth[19] = 0
  expect(readImageDimensions(zeroWidth)).toBeUndefined()
})

test("accepts GIF87a/GIF89a but rejects GIF8 with an invalid version", () => {
  const valid = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 16, 0, 24, 0, 0, 0])
  expect(detectImageMime(valid)).toBe("image/gif")
  expect(readImageDimensions(valid)).toEqual({ width: 16, height: 24 })
  valid[4] = 0x58
  expect(detectImageMime(valid)).toBeUndefined()
  valid[4] = 0x37
  expect(detectImageMime(valid)).toBe("image/gif")
})
