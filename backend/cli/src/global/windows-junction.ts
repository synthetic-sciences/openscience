import path from "node:path"
import { dlopen, FFIType } from "bun:ffi"

/**
 * In-place retargeting for a Windows directory junction.
 *
 * MoveFileEx cannot replace an existing directory, including a junction, so
 * `rename(newJunction, existingJunction)` is not a Windows swap primitive.
 * FSCTL_SET_REPARSE_POINT can modify an existing mount-point reparse record
 * when its tag matches, keeping the stable directory entry in place. The
 * cross-process relocation barrier prevents OpenScience writes during this
 * operation; the post-update realpath check confirms the requested target.
 */
export namespace WindowsJunction {
  type Handle = number | bigint

  export const IO_REPARSE_TAG_MOUNT_POINT = 0xa0000003
  export const FSCTL_SET_REPARSE_POINT = 0x000900a4
  export const FSCTL_GET_REPARSE_POINT = 0x000900a8

  const GENERIC_WRITE = 0x40000000
  const FILE_SHARE_READ = 0x00000001
  const FILE_SHARE_WRITE = 0x00000002
  const FILE_SHARE_DELETE = 0x00000004
  const OPEN_EXISTING = 3
  const FILE_FLAG_BACKUP_SEMANTICS = 0x02000000
  const FILE_FLAG_OPEN_REPARSE_POINT = 0x00200000
  const INVALID_HANDLE_VALUE = 0xffffffffffffffffn

  const definitions = {
    CreateFileW: {
      args: [FFIType.ptr, FFIType.u32, FFIType.u32, FFIType.ptr, FFIType.u32, FFIType.u32, FFIType.u64],
      returns: FFIType.u64,
    },
    DeviceIoControl: {
      args: [FFIType.u64, FFIType.u32, FFIType.ptr, FFIType.u32, FFIType.ptr, FFIType.u32, FFIType.ptr, FFIType.ptr],
      returns: FFIType.i32,
    },
    CloseHandle: {
      args: [FFIType.u64],
      returns: FFIType.i32,
    },
    GetLastError: {
      args: [],
      returns: FFIType.u32,
    },
  } as const

  const openKernel = () => dlopen("kernel32.dll", definitions)
  let kernel: ReturnType<typeof openKernel> | undefined

  function api() {
    if (process.platform !== "win32") throw new Error("Windows junction retargeting is only available on Windows")
    if (process.arch !== "x64" && process.arch !== "arm64") {
      throw new Error(`Windows junction retargeting requires a 64-bit runtime, received ${process.arch}`)
    }
    kernel ??= openKernel()
    return kernel.symbols
  }

  function wide(value: string): Buffer {
    return Buffer.from(`${value}\0`, "utf16le")
  }

  function invalid(handle: Handle): boolean {
    return BigInt(handle) === INVALID_HANDLE_VALUE
  }

  function substitute(target: string): string {
    if (target.startsWith("\\\\?\\UNC\\")) return `\\??\\UNC\\${target.slice(8)}`
    if (target.startsWith("\\\\?\\")) return `\\??\\${target.slice(4)}`
    if (target.startsWith("\\\\")) return `\\??\\UNC\\${target.slice(2)}`
    return `\\??\\${target}`
  }

  function buffer(target: string): Buffer {
    const print = path.win32.resolve(target)
    const internal = substitute(print)
    const internalBytes = Buffer.from(internal, "utf16le")
    const printBytes = Buffer.from(print, "utf16le")
    const paths = Buffer.concat([internalBytes, Buffer.alloc(2), printBytes, Buffer.alloc(2)])
    const data = Buffer.alloc(16 + paths.length)
    data.writeUInt32LE(IO_REPARSE_TAG_MOUNT_POINT, 0)
    data.writeUInt16LE(8 + paths.length, 4)
    data.writeUInt16LE(0, 6)
    data.writeUInt16LE(0, 8)
    data.writeUInt16LE(internalBytes.length, 10)
    data.writeUInt16LE(internalBytes.length + 2, 12)
    data.writeUInt16LE(printBytes.length, 14)
    paths.copy(data, 16)
    if (data.length > 16 * 1024) throw new Error(`Junction target is too long: ${print}`)
    return data
  }

  export function retarget(junction: string, target: string): void {
    const symbols = api()
    const handle = symbols.CreateFileW(
      wide(junction),
      GENERIC_WRITE,
      FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
      null,
      OPEN_EXISTING,
      FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT,
      0,
    ) as Handle
    if (invalid(handle)) {
      throw new Error(`CreateFileW(${junction}) failed (Win32 error ${Number(symbols.GetLastError())})`)
    }
    try {
      const current = Buffer.alloc(16 * 1024)
      const currentSize = Buffer.alloc(4)
      if (
        !symbols.DeviceIoControl(handle, FSCTL_GET_REPARSE_POINT, null, 0, current, current.length, currentSize, null)
      ) {
        throw new Error(`FSCTL_GET_REPARSE_POINT(${junction}) failed (Win32 error ${Number(symbols.GetLastError())})`)
      }
      if (current.readUInt32LE(0) !== IO_REPARSE_TAG_MOUNT_POINT) {
        throw new Error(`${junction} is not a managed Windows directory junction`)
      }
      const input = buffer(target)
      const returned = Buffer.alloc(4)
      if (!symbols.DeviceIoControl(handle, FSCTL_SET_REPARSE_POINT, input, input.length, null, 0, returned, null)) {
        throw new Error(`FSCTL_SET_REPARSE_POINT(${junction}) failed (Win32 error ${Number(symbols.GetLastError())})`)
      }
    } finally {
      symbols.CloseHandle(handle)
    }
  }

  export function bufferForTests(target: string): Buffer {
    return buffer(target)
  }
}
