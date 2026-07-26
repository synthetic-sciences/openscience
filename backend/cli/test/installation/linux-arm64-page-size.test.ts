import { describe, expect, test } from "bun:test"
import os from "node:os"
import path from "node:path"
import { mkdtemp, rm } from "node:fs/promises"
import { assertLinuxArm64PageSize } from "../../script/linux-arm64-page-size"

function elf(loads: { offset: bigint; vaddr: bigint; align: bigint }[]) {
  const bytes = new Uint8Array(64 + loads.length * 56)
  const view = new DataView(bytes.buffer)

  bytes.set([0x7f, 0x45, 0x4c, 0x46], 0)
  bytes[4] = 2
  bytes[5] = 1
  bytes[6] = 1

  view.setUint16(16, 2, true)
  view.setUint16(18, 183, true)
  view.setUint32(20, 1, true)
  view.setBigUint64(32, 64n, true)
  view.setUint16(52, 64, true)
  view.setUint16(54, 56, true)
  view.setUint16(56, loads.length, true)

  for (const [index, load] of loads.entries()) {
    const base = 64 + index * 56
    view.setUint32(base, 1, true)
    view.setUint32(base + 4, 5, true)
    view.setBigUint64(base + 8, load.offset, true)
    view.setBigUint64(base + 16, load.vaddr, true)
    view.setBigUint64(base + 32, 0x1000n, true)
    view.setBigUint64(base + 40, 0x1000n, true)
    view.setBigUint64(base + 48, load.align, true)
  }

  return bytes
}

describe("linux-arm64 release page-size guard", () => {
  test("accepts load segments aligned for 64KB-page kernels", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "openscience-arm64-page-ok-"))
    const file = path.join(dir, "openscience")

    await Bun.write(file, elf([{ offset: 0x10000n, vaddr: 0x210000n, align: 0x10000n }]))

    try {
      await expect(assertLinuxArm64PageSize(file)).resolves.toEqual({
        loads: 1,
      })
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("rejects 4KB-aligned load segments before publishing linux-arm64 binaries", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "openscience-arm64-page-bad-"))
    const file = path.join(dir, "openscience")

    await Bun.write(file, elf([{ offset: 0x1000n, vaddr: 0x201000n, align: 0x1000n }]))

    try {
      await expect(assertLinuxArm64PageSize(file)).rejects.toThrow("-z max-page-size=65536")
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
