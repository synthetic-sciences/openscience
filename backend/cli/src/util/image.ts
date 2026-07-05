/**
 * Detect actual image MIME type from raw bytes by checking magic bytes.
 * Returns undefined if format is not recognized.
 */
export function detectImageMime(bytes: Uint8Array): string | undefined {
  if (bytes.length < 4) return undefined

  // PNG: 89 50 4E 47
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return "image/png"

  // JPEG: FF D8 FF
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg"

  // GIF: 47 49 46 38 (GIF8)
  if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38) return "image/gif"

  // WebP: RIFF....WEBP
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  )
    return "image/webp"

  // TIFF: 49 49 2A 00 (little-endian) or 4D 4D 00 2A (big-endian)
  if (
    (bytes[0] === 0x49 && bytes[1] === 0x49 && bytes[2] === 0x2a && bytes[3] === 0x00) ||
    (bytes[0] === 0x4d && bytes[1] === 0x4d && bytes[2] === 0x00 && bytes[3] === 0x2a)
  )
    return "image/tiff"

  // BMP: 42 4D
  if (bytes[0] === 0x42 && bytes[1] === 0x4d) return "image/bmp"

  return undefined
}

/**
 * Detect image MIME from a base64-encoded string.
 */
export function detectImageMimeFromBase64(base64: string): string | undefined {
  const clean = base64.replace(/\s/g, "")
  const slice = clean.slice(0, 24) // enough bytes for magic detection
  const bytes = Buffer.from(slice, "base64")
  return detectImageMime(bytes)
}

/**
 * Given declared mime and actual image bytes, return the correct mime.
 * Falls back to declared if detection fails.
 */
export function correctImageMime(declared: string, bytes: Uint8Array): string {
  if (!declared.startsWith("image/")) return declared
  const detected = detectImageMime(bytes)
  return detected ?? declared
}

/**
 * Given declared mime and base64 data, return the correct mime.
 */
export function correctImageMimeFromBase64(declared: string, base64: string): string {
  if (!declared.startsWith("image/")) return declared
  const detected = detectImageMimeFromBase64(base64)
  return detected ?? declared
}

/**
 * Read image dimensions from raw header bytes without decoding the full image.
 * Returns undefined for unsupported formats (SVG/TIFF/BMP/unknown).
 * Supports PNG, JPEG, GIF, WebP (VP8/VP8L/VP8X).
 */
export function readImageDimensions(bytes: Uint8Array): { width: number; height: number } | undefined {
  if (bytes.length < 12) return undefined
  const mime = detectImageMime(bytes)

  if (mime === "image/png") {
    // 8-byte signature, then IHDR: 4-byte length, 4-byte type "IHDR", width (BE u32) at 16, height at 20
    if (bytes.length < 24) return undefined
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    return { width: view.getUint32(16, false), height: view.getUint32(20, false) }
  }

  if (mime === "image/gif") {
    // Logical screen width/height at offsets 6-9, little-endian u16
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    return { width: view.getUint16(6, true), height: view.getUint16(8, true) }
  }

  if (mime === "image/jpeg") {
    // Walk segments until we hit an SOF marker (excluding DHT/DAC/DQT/DRI/SOI/EOI/DNL/APPn/COM)
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    let i = 2 // skip SOI (FFD8)
    while (i + 9 < bytes.length) {
      if (bytes[i] !== 0xff) return undefined
      // Skip fill bytes
      while (bytes[i] === 0xff && i < bytes.length) i++
      const marker = bytes[i]
      i++
      // Standalone markers (no payload): RST0-7 (D0-D7), SOI (D8), EOI (D9), TEM (01)
      if (marker === 0xd8 || marker === 0xd9 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue
      if (i + 1 >= bytes.length) return undefined
      const segLen = view.getUint16(i, false)
      // SOF markers: C0-C3, C5-C7, C9-CB, CD-CF (C4=DHT, C8=JPG, CC=DAC are not SOF)
      const isSOF =
        (marker >= 0xc0 && marker <= 0xc3) ||
        (marker >= 0xc5 && marker <= 0xc7) ||
        (marker >= 0xc9 && marker <= 0xcb) ||
        (marker >= 0xcd && marker <= 0xcf)
      if (isSOF) {
        // Layout after length: 1-byte precision, 2-byte height, 2-byte width
        if (i + 7 >= bytes.length) return undefined
        const height = view.getUint16(i + 3, false)
        const width = view.getUint16(i + 5, false)
        return { width, height }
      }
      i += segLen
    }
    return undefined
  }

  if (mime === "image/webp") {
    // RIFF header: "RIFF" (0-3), file size (4-7), "WEBP" (8-11), then chunk FourCC (12-15)
    if (bytes.length < 30) return undefined
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    const chunk = String.fromCharCode(bytes[12], bytes[13], bytes[14], bytes[15])
    if (chunk === "VP8 ") {
      // Lossy: frame tag at 20, start code 9D 01 2A at 23-25, width (14 bits LE) at 26, height at 28
      if (bytes[23] !== 0x9d || bytes[24] !== 0x01 || bytes[25] !== 0x2a) return undefined
      const width = view.getUint16(26, true) & 0x3fff
      const height = view.getUint16(28, true) & 0x3fff
      return { width, height }
    }
    if (chunk === "VP8L") {
      // Lossless: signature byte 0x2f at 20, then 14-bit width-1, 14-bit height-1 packed LE at 21-24
      if (bytes[20] !== 0x2f) return undefined
      const b0 = bytes[21],
        b1 = bytes[22],
        b2 = bytes[23],
        b3 = bytes[24]
      const width = 1 + (((b1 & 0x3f) << 8) | b0)
      const height = 1 + (((b3 & 0x0f) << 10) | (b2 << 2) | ((b1 & 0xc0) >> 6))
      return { width, height }
    }
    if (chunk === "VP8X") {
      // Extended: canvas width-1 (3 bytes LE) at 24, canvas height-1 at 27
      if (bytes.length < 30) return undefined
      const width = 1 + (bytes[24] | (bytes[25] << 8) | (bytes[26] << 16))
      const height = 1 + (bytes[27] | (bytes[28] << 8) | (bytes[29] << 16))
      return { width, height }
    }
    return undefined
  }

  return undefined
}
