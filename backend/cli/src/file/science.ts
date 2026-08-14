import path from "node:path"
import fs from "node:fs/promises"
import os from "node:os"
import { spawn, type ChildProcess } from "node:child_process"
import z from "zod"
import { Config } from "@/config/config"
import { CredentialProcessLedger } from "@/credentials/process-ledger"
import { OpenScience } from "@/openscience"
import { AuthoritySignal } from "@/project/authority-signal"
import { ExecutionAuthority } from "@/project/execution"
import { Instance } from "@/project/instance"
import { ProjectTrust } from "@/project/trust"
import { Sandbox } from "@/sandbox/sandbox"
import { CommandRuntime } from "@/science/command/registry"
import { SessionFilesystem } from "@/session/filesystem"
import { Shell } from "@/shell/shell"

export namespace ScienceFile {
  const TOOL_TIMEOUT_MS = 20_000
  const MAX_STDOUT_BYTES = 8 * 1024 * 1024
  const MAX_STDERR_BYTES = 64 * 1024

  export interface InspectOptions {
    sessionID?: string
  }

  export const Format = z.enum(["bam", "cram", "h5ad", "loom"])
  export type Format = z.infer<typeof Format>

  export const Inspection = z.object({
    format: Format,
    name: z.string(),
    size: z.number(),
    modified: z.number(),
    signature: z.boolean(),
    index: z.string().optional(),
    tool: z.object({
      name: z.string(),
      available: z.boolean(),
      detail: z.string().optional(),
    }),
    details: z.record(z.string(), z.unknown()),
  })
  export type Inspection = z.infer<typeof Inspection>

  const python = String.raw`
import json, sys
try:
    import h5py
except Exception as exc:
    print(json.dumps({"error": "h5py is not available", "detail": str(exc)}))
    raise SystemExit(2)

target = sys.argv[1]
result = {"groups": [], "datasets": [], "attributes": {}, "summary": {}}

def clean(value):
    if hasattr(value, "tolist"):
        value = value.tolist()
    if isinstance(value, bytes):
        return value.decode("utf-8", "replace")
    if isinstance(value, (str, int, float, bool)) or value is None:
        return value
    if isinstance(value, (list, tuple)):
        return [clean(item) for item in value[:50]]
    return str(value)

def text(value):
    value = clean(value)
    return str(value) if value is not None else ""

def labels(handle, key, indices):
    if not key or "obs" not in handle:
        return []
    value = handle["obs"].get(key)
    if value is None:
        return []
    try:
        if isinstance(value, h5py.Group) and "codes" in value and "categories" in value:
            codes = value["codes"][indices]
            categories = value["categories"][:]
            return [text(categories[int(code)]) if int(code) >= 0 and int(code) < len(categories) else "" for code in codes]
        return [text(item) for item in value[indices]]
    except Exception:
        return []

with h5py.File(target, "r") as handle:
    result["attributes"] = {str(key): clean(value) for key, value in list(handle.attrs.items())[:50]}

    def visit(name, value):
        if len(result["groups"]) + len(result["datasets"]) >= 500:
            return
        if isinstance(value, h5py.Group):
            result["groups"].append(name)
            return
        result["datasets"].append({
            "path": name,
            "shape": list(value.shape),
            "dtype": str(value.dtype),
            "bytes": int(value.size * value.dtype.itemsize),
        })

    handle.visititems(visit)
    matrix = handle.get("X")
    if matrix is None:
        matrix = handle.get("matrix")
    if matrix is not None and hasattr(matrix, "shape"):
        result["summary"]["matrix"] = list(matrix.shape)
    if "obs" in handle:
        obs_index = handle["obs"].get("_index")
        if obs_index is not None:
            result["summary"]["observations"] = len(obs_index)
    if "var" in handle:
        var_index = handle["var"].get("_index")
        if var_index is not None:
            result["summary"]["variables"] = len(var_index)
    if matrix is not None and hasattr(matrix, "shape") and len(matrix.shape) >= 2:
        result["summary"].setdefault("observations", int(matrix.shape[0]))
        result["summary"].setdefault("variables", int(matrix.shape[1]))
    if "obsm" in handle:
        result["summary"]["embeddings"] = list(handle["obsm"].keys())[:100]
        preferred = ["X_umap", "X_tsne", "X_pca", "spatial"]
        names = list(handle["obsm"].keys())
        selected = next((name for name in preferred if name in names), names[0] if names else None)
        value = handle["obsm"].get(selected) if selected else None
        if value is not None and isinstance(value, h5py.Dataset) and len(value.shape) == 2 and value.shape[1] >= 2:
            total = int(value.shape[0])
            count = min(total, 2500)
            indices = [int(index * total / count) for index in range(count)] if count else []
            coords = value[indices, :2] if indices else []
            label_names = ["cell_type", "celltype", "leiden", "louvain", "cluster", "batch"]
            label_key = next((name for name in label_names if "obs" in handle and name in handle["obs"]), None)
            categories = labels(handle, label_key, indices)
            result["embedding"] = {
                "name": selected,
                "label": label_key,
                "total": total,
                "points": [
                    {
                        "x": float(point[0]),
                        "y": float(point[1]),
                        **({"label": categories[index]} if index < len(categories) and categories[index] else {}),
                    }
                    for index, point in enumerate(coords)
                ],
            }
    if "layers" in handle:
        result["summary"]["layers"] = list(handle["layers"].keys())[:100]
    if "row_attrs" in handle:
        result["summary"]["row_attributes"] = list(handle["row_attrs"].keys())[:100]
    if "col_attrs" in handle:
        result["summary"]["column_attributes"] = list(handle["col_attrs"].keys())[:100]
        if "embedding" not in result:
            candidates = [
                (name, handle["col_attrs"].get(name))
                for name in ["X_umap", "UMAP", "Embedding", "_Embedding", "TSNE"]
                if name in handle["col_attrs"]
            ]
            selected = candidates[0] if candidates else None
            if selected and isinstance(selected[1], h5py.Dataset) and len(selected[1].shape) == 2 and selected[1].shape[1] >= 2:
                value = selected[1]
                total = int(value.shape[0])
                count = min(total, 2500)
                indices = [int(index * total / count) for index in range(count)] if count else []
                coords = value[indices, :2] if indices else []
                result["embedding"] = {
                    "name": selected[0],
                    "total": total,
                    "points": [{"x": float(point[0]), "y": float(point[1])} for point in coords],
                }

print(json.dumps(result))
`

  export function format(file: string): Format | undefined {
    const extension = path.extname(file).slice(1).toLowerCase()
    return Format.options.find((value) => value === extension)
  }

  export function binary(file: string): boolean {
    return format(file) !== undefined
  }

  export async function inspect(full: string, relative: string, options: InspectOptions = {}): Promise<Inspection> {
    const kind = format(relative)
    if (!kind) throw new Error(`Unsupported scientific binary format`)
    const file = Bun.file(full)
    if (!(await file.exists())) throw new Error(`File not found: ${relative}`)
    const stat = await file.stat()
    const bytes = new Uint8Array(await file.slice(0, 16).arrayBuffer())
    const base = {
      format: kind,
      name: path.basename(relative),
      size: stat.size,
      modified: stat.mtimeMs,
    }
    const trusted = await ProjectTrust.allowed(Instance.project)
    if (kind === "h5ad" || kind === "loom") return inspectHdf5(full, relative, base, bytes, trusted, options)
    return inspectAlignment(full, relative, base, bytes, trusted, options)
  }

  async function inspectHdf5(
    full: string,
    relative: string,
    base: Pick<Inspection, "format" | "name" | "size" | "modified">,
    bytes: Uint8Array,
    trusted: boolean,
    options: InspectOptions,
  ): Promise<Inspection> {
    const signature = [0x89, 0x48, 0x44, 0x46, 0x0d, 0x0a, 0x1a, 0x0a].every((value, index) => bytes[index] === value)
    if (!trusted) {
      return {
        ...base,
        signature,
        tool: {
          name: "h5py",
          available: false,
          detail: "Trust this project to enable isolated h5py inspection",
        },
        details: {},
      }
    }
    const bin = Bun.which("python3", { PATH: process.env.PATH }) ?? Bun.which("python", { PATH: process.env.PATH })
    if (!bin) {
      return {
        ...base,
        signature,
        tool: { name: "h5py", available: false, detail: "Python is not available on PATH" },
        details: {},
      }
    }
    const result = await command([bin, "-c", python, full], [full], relative, options).catch((error) => ({
      code: 1,
      stdout: "",
      stderr: error instanceof Error ? error.message : String(error),
    }))
    const data = result.code === 0 ? json(result.stdout) : undefined
    return {
      ...base,
      signature,
      tool: {
        name: "h5py",
        available: result.code === 0,
        detail:
          result.code === 0
            ? `inspected with ${path.basename(bin)}`
            : detail(result.stdout, result.stderr) ||
              "Install h5py in the Python environment used to launch OpenScience",
      },
      details: data ?? {},
    }
  }

  async function inspectAlignment(
    full: string,
    relative: string,
    base: Pick<Inspection, "format" | "name" | "size" | "modified">,
    bytes: Uint8Array,
    trusted: boolean,
    options: InspectOptions,
  ): Promise<Inspection> {
    const cram = base.format === "cram"
    const signature = cram
      ? bytes[0] === 0x43 && bytes[1] === 0x52 && bytes[2] === 0x41 && bytes[3] === 0x4d
      : bytes[0] === 0x1f && bytes[1] === 0x8b
    const index = await findIndex(full, relative, cram, options)
    const version = cram && signature ? `${bytes[4] ?? 0}.${bytes[5] ?? 0}` : undefined
    if (!trusted) {
      return {
        ...base,
        signature,
        index: index?.relative,
        tool: {
          name: "samtools",
          available: false,
          detail: "Trust this project to enable isolated samtools inspection",
        },
        details: version ? { version } : {},
      }
    }
    const bin = Bun.which("samtools", { PATH: process.env.PATH })
    if (!bin) {
      return {
        ...base,
        signature,
        index: index?.relative,
        tool: { name: "samtools", available: false, detail: "Install samtools to inspect headers and references" },
        details: version ? { version } : {},
      }
    }
    const readable = [full, ...(index ? [index.full] : [])]
    const header = await command([bin, "view", "-H", full], readable, relative, options).catch((error) => ({
      code: 1,
      stdout: "",
      stderr: error instanceof Error ? error.message : String(error),
    }))
    const refs = header.stdout
      .split(/\r?\n/)
      .filter((line) => line.startsWith("@SQ"))
      .map((line) =>
        Object.fromEntries(
          line
            .split("\t")
            .slice(1)
            .map((part) => part.split(":", 2)),
        ),
      )
      .map((record) => ({ name: record.SN ?? "", length: Number(record.LN) || 0 }))
    const hd = header.stdout
      .split(/\r?\n/)
      .find((line) => line.startsWith("@HD"))
      ?.split("\t")
      .slice(1)
      .map((part) => part.split(":", 2))
    const stats = index
      ? await command([bin, "idxstats", full], readable, relative, options).catch((error) => ({
          code: 1,
          stdout: "",
          stderr: error instanceof Error ? error.message : String(error),
        }))
      : undefined
    const chromosomes =
      stats?.code === 0
        ? stats.stdout
            .split(/\r?\n/)
            .filter(Boolean)
            .map((line) => line.split("\t"))
            .filter((row) => row[0] !== "*")
            .map((row) => ({
              name: row[0] ?? "",
              length: Number(row[1]) || 0,
              mapped: Number(row[2]) || 0,
              unmapped: Number(row[3]) || 0,
            }))
        : []
    return {
      ...base,
      signature,
      index: index?.relative,
      tool: {
        name: "samtools",
        available: header.code === 0,
        detail: header.code === 0 ? "header inspected locally" : detail(header.stdout, header.stderr),
      },
      details: {
        ...(version ? { version } : {}),
        header: hd ? Object.fromEntries(hd) : {},
        references: refs,
        chromosomes,
      },
    }
  }

  async function findIndex(
    full: string,
    relative: string,
    cram: boolean,
    options: InspectOptions,
  ): Promise<{ full: string; relative: string } | undefined> {
    const extension = cram ? ".crai" : ".bai"
    const candidates = [full + extension, full.replace(/\.[^.]+$/, extension)]
    const found = await Promise.all(
      candidates.map(async (candidate) => {
        if (!(await Bun.file(candidate).exists())) return
        const canonical = await fs.realpath(candidate).catch(() => undefined)
        if (!canonical) return
        if (options.sessionID) {
          const authorized = await SessionFilesystem.authorize({
            sessionID: options.sessionID,
            path: canonical,
            access: "read",
          }).catch(() => undefined)
          if (!authorized || path.resolve(authorized.path) !== path.resolve(canonical)) return
        } else if (!(await Instance.containsCanonicalPath(canonical))) {
          return
        }
        return canonical
      }),
    )
    const value = found.find(Boolean)
    if (!value) return
    return {
      full: value,
      relative: path.join(path.dirname(relative), path.basename(value)).replace(/^\.\//, ""),
    }
  }

  function environment(scratch: string): Record<string, string> {
    const keys =
      process.platform === "win32"
        ? ["PATH", "PATHEXT", "SYSTEMROOT", "WINDIR", "COMSPEC", "TEMP", "TMP"]
        : ["PATH", "LANG"]
    const result = Object.fromEntries(keys.flatMap((key) => (process.env[key] ? [[key, process.env[key]!]] : [])))
    for (const [key, value] of Object.entries(process.env)) {
      if (value && key.startsWith("LC_")) result[key] = value
    }
    return {
      ...result,
      HOME: scratch,
      TMPDIR: scratch,
      TMP: scratch,
      TEMP: scratch,
      XDG_CACHE_HOME: path.join(scratch, "cache"),
      XDG_CONFIG_HOME: path.join(scratch, "config"),
      XDG_DATA_HOME: path.join(scratch, "data"),
      PYTHONNOUSERSITE: "1",
      PYTHONSAFEPATH: "1",
      PYTHONDONTWRITEBYTECODE: "1",
      PYTHONUNBUFFERED: "1",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
      GIT_TERMINAL_PROMPT: "0",
    }
  }

  function output(stream: NodeJS.ReadableStream | null, limit: number, name: "stdout" | "stderr"): Promise<string> {
    if (!stream) return Promise.resolve("")
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = []
      let size = 0
      let settled = false
      const fail = (error: unknown) => {
        if (settled) return
        settled = true
        reject(error)
      }
      stream.on("data", (value: Buffer | string) => {
        if (settled) return
        const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value)
        size += chunk.length
        if (size > limit) {
          fail(new Error(`Scientific preview ${name} exceeded ${limit} bytes`))
          return
        }
        chunks.push(chunk)
      })
      stream.once("error", fail)
      stream.once("end", () => {
        if (settled) return
        settled = true
        resolve(Buffer.concat(chunks, size).toString("utf8"))
      })
    })
  }

  async function stop(child: ChildProcess): Promise<void> {
    await Shell.killTree(child, {
      detached: process.platform !== "win32",
      exited: () => child.exitCode !== null || child.signalCode !== null,
    })
  }

  async function command(
    args: string[],
    readable: string[],
    relative: string,
    options: InspectOptions,
  ): Promise<{ code: number; stdout: string; stderr: string }> {
    const scratch = await fs.mkdtemp(path.join(os.tmpdir(), `openscience-science-preview-${process.pid}-`))
    let sandbox: Sandbox.Wrapped | undefined
    let child: ChildProcess | undefined
    let registered: Awaited<ReturnType<typeof CommandRuntime.start>> | undefined
    try {
      const launched = await AuthoritySignal.exclusive(async () => {
        const trust = await ProjectTrust.status(Instance.project)
        if (!trust.canExecuteProjectCode) throw new Error("Project trust was revoked before scientific inspection")

        let generation = `science-preview:${trust.revision}`
        let policy = await Config.trustedSandbox()
        if (options.sessionID) {
          const decision = await ExecutionAuthority.decide({
            projectID: Instance.project.id,
            sessionID: options.sessionID,
            capability: "kernel",
          })
          if (!decision.allowed) throw new ExecutionAuthority.DeniedError(decision)
          const authorized = await SessionFilesystem.authorize({
            sessionID: options.sessionID,
            path: relative,
            access: "read",
          })
          if (path.resolve(authorized.path) !== path.resolve(readable[0]!)) {
            throw new Error("Scientific preview authority changed while the file was being inspected")
          }
          generation = decision.generation
          policy = decision.sandbox
        } else if (!(await Instance.containsCanonicalPath(readable[0]!))) {
          throw new Error("Scientific preview target left the trusted project")
        }

        sandbox = Sandbox.wrapArgv({
          file: args[0]!,
          args: args.slice(1),
          workspace: [],
          readable,
          extraWritable: [scratch],
          unreadable: OpenScience.kernelSensitivePaths(),
          options: { ...policy, network: "deny" },
        })
        const wrapped = await CommandRuntime.wrap({
          file: sandbox.file,
          args: sandbox.args,
        })
        child = spawn(wrapped.file, wrapped.args, {
          cwd: scratch,
          env: environment(scratch),
          stdio: ["ignore", "pipe", "pipe"],
          detached: process.platform !== "win32",
          windowsHide: true,
        })
        const completion = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
          child!.once("error", reject)
          child!.once("close", (code, signal) => resolve({ code, signal }))
        })
        registered = await CommandRuntime.start(
          {
            projectID: Instance.project.id,
            sessionID: options.sessionID ?? "file-preview",
            messageID: "file.inspect",
            description: `Inspect ${path.basename(relative)}`,
            command: `${path.basename(args[0]!)} scientific preview`,
          },
          child,
          () => stop(child!),
          { authorityGeneration: generation, windowsRelease: wrapped.release },
        )
        return { completion, child, registered }
      })

      let timer: ReturnType<typeof setTimeout> | undefined
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("Scientific preview timed out after 20 seconds")), TOOL_TIMEOUT_MS)
        timer.unref()
      })
      const [result, stdout, stderr] = await Promise.race([
        Promise.all([
          launched.completion,
          output(launched.child.stdout, MAX_STDOUT_BYTES, "stdout"),
          output(launched.child.stderr, MAX_STDERR_BYTES, "stderr"),
        ]),
        timeout,
      ]).finally(() => clearTimeout(timer))
      await CredentialProcessLedger.complete(launched.registered.id)
      CommandRuntime.finish(launched.registered.id)
      return { code: result.code ?? 1, stdout, stderr }
    } catch (error) {
      const failures: unknown[] = []
      if (registered) {
        await CredentialProcessLedger.revoke({ id: registered.id, kind: "command" }).catch((failure) =>
          failures.push(failure),
        )
        if (!failures.length) CommandRuntime.finish(registered.id)
      }
      if (child && child.exitCode === null && child.signalCode === null) {
        await stop(child).catch((failure) => failures.push(failure))
      }
      if (failures.length) {
        throw new AggregateError([error, ...failures], "Scientific preview ownership cleanup failed")
      }
      throw error
    } finally {
      if (sandbox) Sandbox.cleanup(sandbox)
      await fs.rm(scratch, { recursive: true, force: true })
    }
  }

  function json(value: string): Record<string, unknown> | undefined {
    try {
      const parsed: unknown = JSON.parse(value)
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return
      return parsed as Record<string, unknown>
    } catch {
      return
    }
  }

  function detail(stdout: string, stderr: string): string {
    return (stderr.trim() || stdout.trim()).slice(0, 500)
  }
}
