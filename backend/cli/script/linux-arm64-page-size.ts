const PAGE = 65_536n
const ELF = [0x7f, 0x45, 0x4c, 0x46]
const AARCH64 = 183
const LOAD = 1

type Segment = {
  index: number
  offset: bigint
  vaddr: bigint
  align: bigint
}

function hex(value: bigint) {
  return `0x${value.toString(16)}`
}

export async function assertLinuxArm64PageSize(file: string): Promise<{ loads: number }> {
  const bytes = new Uint8Array(await Bun.file(file).arrayBuffer())
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const valid =
    bytes.length >= 64 &&
    ELF.every((byte, index) => bytes[index] === byte) &&
    bytes[4] === 2 &&
    (bytes[5] === 1 || bytes[5] === 2)

  if (!valid) {
    throw new Error(`Expected ${file} to be an ELF64 executable`)
  }

  const little = bytes[5] === 1
  const machine = view.getUint16(18, little)
  if (machine !== AARCH64) {
    throw new Error(`Expected ${file} to be an AArch64 ELF executable, found e_machine=${machine}`)
  }

  const phoff = Number(view.getBigUint64(32, little))
  const size = view.getUint16(54, little)
  const count = view.getUint16(56, little)
  const segments = Array.from({ length: count }, (_, index): Segment | undefined => {
    const base = phoff + index * size
    if (base + size > bytes.length) return undefined
    if (view.getUint32(base, little) !== LOAD) return undefined
    return {
      index,
      offset: view.getBigUint64(base + 8, little),
      vaddr: view.getBigUint64(base + 16, little),
      align: view.getBigUint64(base + 48, little),
    }
  }).filter((segment): segment is Segment => segment !== undefined)
  const bad = segments.filter((segment) => segment.align < PAGE || segment.offset % PAGE !== segment.vaddr % PAGE)

  if (segments.length === 0) {
    throw new Error(`Expected ${file} to contain ELF PT_LOAD segments`)
  }

  if (bad.length > 0) {
    const details = bad
      .map(
        (segment) =>
          `PT_LOAD[${segment.index}] align=${hex(segment.align)} offset=${hex(segment.offset)} vaddr=${hex(
            segment.vaddr,
          )}`,
      )
      .join("; ")
    throw new Error(
      `Linux ARM64 binary is not compatible with 64KB-page kernels. ` +
        `Build with a Bun runtime linked using -z max-page-size=65536. ${details}`,
    )
  }

  return { loads: segments.length }
}
