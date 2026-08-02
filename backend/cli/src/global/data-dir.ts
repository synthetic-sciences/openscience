import fs from "fs/promises"
import { createHash } from "node:crypto"
import { createReadStream } from "node:fs"
import path from "node:path"

const reserved = new Set(["bin", ".xdg-data-migration-v1.json"])

export interface DataResolution {
  path: string
  migrated?: { source: string; target: string; files: number; bytes: number }
  conflict?: { legacy: string; current: string }
  error?: string
}

async function entries(root: string) {
  return fs.readdir(root, { withFileTypes: true }).catch(() => [])
}

async function hash(file: string) {
  const value = createHash("sha256")
  for await (const chunk of createReadStream(file)) value.update(chunk)
  return value.digest("hex")
}

async function manifest(root: string) {
  const stack = [root]
  const files: Array<{ path: string; bytes: number; sha256: string }> = []
  while (stack.length) {
    const dir = stack.pop()
    if (!dir) continue
    for (const entry of await entries(dir)) {
      const full = path.join(dir, entry.name)
      if (entry.isSymbolicLink()) continue
      if (entry.isDirectory()) {
        stack.push(full)
        continue
      }
      if (!entry.isFile()) continue
      const stat = await fs.stat(full)
      files.push({ path: path.relative(root, full), bytes: stat.size, sha256: await hash(full) })
    }
  }
  return files.sort((a, b) => a.path.localeCompare(b.path))
}

async function copy(source: string, target: string) {
  await fs.mkdir(target, { recursive: true })
  for (const entry of await entries(source)) {
    if (reserved.has(entry.name) || entry.isSymbolicLink()) continue
    await fs.cp(path.join(source, entry.name), path.join(target, entry.name), {
      recursive: true,
      force: false,
      errorOnExist: true,
    })
  }
}

export async function resolveDataDirectory(input: {
  home: string
  legacy: string
  explicit?: string
  pointer?: string
}): Promise<DataResolution> {
  if (input.explicit) return { path: path.resolve(input.explicit) }
  if (input.pointer) return { path: path.resolve(input.pointer) }

  const target = path.join(path.resolve(input.home), ".openscience")
  const legacy = path.resolve(input.legacy)
  const migrated = await fs
    .stat(path.join(target, ".xdg-data-migration-v1.json"))
    .then((stat) => stat.isFile())
    .catch(() => false)
  if (migrated) return { path: target }
  const source = await entries(legacy)
  if (source.length === 0 || legacy === target) return { path: target }

  const occupied = (await entries(target)).filter((entry) => !reserved.has(entry.name))
  if (occupied.length > 0) {
    return { path: target, conflict: { legacy, current: target } }
  }

  const stage = await fs.mkdtemp(path.join(path.resolve(input.home), ".openscience-migrate-"))
  const moved: string[] = []
  const result = await copy(legacy, stage)
    .then(async () => {
      const before = await manifest(stage)
      const original = (await manifest(legacy)).filter((file) => !reserved.has(file.path.split(path.sep)[0]))
      if (JSON.stringify(before) !== JSON.stringify(original)) throw new Error("checksum verification failed")
      await fs.mkdir(target, { recursive: true })
      for (const entry of await entries(stage)) {
        await fs.rename(path.join(stage, entry.name), path.join(target, entry.name))
        moved.push(entry.name)
      }
      const bytes = before.reduce((total, file) => total + file.bytes, 0)
      const migrated = { source: legacy, target, files: before.length, bytes }
      await Bun.write(
        path.join(target, ".xdg-data-migration-v1.json"),
        `${JSON.stringify({ ...migrated, migratedAt: Date.now() }, null, 2)}\n`,
        { mode: 0o600 },
      )
      return { path: target, migrated } satisfies DataResolution
    })
    .catch(async (error: unknown) => {
      await Promise.all(
        moved
          .reverse()
          .map((name) =>
            fs
              .rename(path.join(target, name), path.join(stage, name))
              .catch(() => fs.rm(path.join(target, name), { recursive: true, force: true })),
          ),
      )
      return {
        path: legacy,
        error: error instanceof Error ? error.message : String(error),
      }
    })
  await fs.rm(stage, { recursive: true, force: true })
  return result
}
