import { Global } from "@/global"
import { Instance } from "@/project/instance"
import { pythonEnvironment } from "@/science/kernel/interpreter"
import type { KernelStartOptions } from "@/science/kernel/types"
import { createHash } from "node:crypto"
import { mkdirSync } from "node:fs"
import path from "node:path"

export namespace KernelEnvironmentMutation {
  export type Language = "python" | "r"

  export type Plan = {
    language: Language
    environment: string
    operation: "package_install" | "package_remove" | "environment_update"
    manager: string
    digest: string
    restart: true
  }

  function normalized(code: string) {
    return code
      .replace(/[^A-Za-z0-9_.:+/@=-]+/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .toLowerCase()
  }

  function pipOperation(code: string): "install" | "remove" | undefined {
    const tokens = code.split(" ")
    const entrypoints = new Set(["pip", "pip._internal", "pip._internal.main"])
    for (let index = 0; index < tokens.length; index++) {
      if (!entrypoints.has(tokens[index] ?? "")) continue
      let cursor = index + 1
      while (cursor < tokens.length && /^--?[a-z0-9_.=+-]+$/.test(tokens[cursor] ?? "")) cursor++
      const operation = tokens[cursor]
      if (operation === "install" || operation === "download") return "install"
      if (operation === "uninstall") return "remove"
      index = cursor - 1
    }
  }

  /**
   * Conservatively recognize package and environment mutation submitted to a
   * plain interpreter. The normalized form also catches safe argv-based calls
   * such as `[sys.executable, "-m", "pip", "install", ...]` without asking
   * the model to use shell syntax or a notebook magic.
   */
  export function detect(input: { language: Language; environment: string; code: string }): Plan | undefined {
    const code = normalized(input.code)
    let operation: Plan["operation"] | undefined
    let manager: string | undefined

    if (input.language === "python") {
      const pip = pipOperation(code)
      if (pip === "install") {
        operation = "package_install"
        manager = "pip"
      } else if (pip === "remove") {
        operation = "package_remove"
        manager = "pip"
      } else if (/\b(?:uv\s+pip|conda|mamba)\s+(?:install|add)\b|\bpoetry\s+add\b/.test(code)) {
        operation = "package_install"
        manager = code.includes("uv pip") ? "uv" : code.includes("poetry") ? "poetry" : "conda"
      } else if (
        /\b(?:uv\s+pip|conda|mamba)\s+(?:uninstall|remove|update)\b|\bpoetry\s+(?:remove|update)\b/.test(code)
      ) {
        operation = "environment_update"
        manager = code.includes("uv pip") ? "uv" : code.includes("poetry") ? "poetry" : "conda"
      } else if (
        /\b(?:python(?:\d+(?:\.\d+)?)?|sys\.executable)\s+-m\s+(?:venv|virtualenv)\b|\bvenv\.envbuilder\b/.test(code)
      ) {
        operation = "environment_update"
        manager = "venv"
      }
    } else {
      if (/\binstall\.packages\b|\bbiocmanager::install\b|\bpak::pkg_install\b|\brenv::install\b/.test(code)) {
        operation = "package_install"
        manager = code.includes("renv::")
          ? "renv"
          : code.includes("pak::")
            ? "pak"
            : code.includes("biocmanager::")
              ? "BiocManager"
              : "install.packages"
      } else if (/\bremove\.packages\b|\bpak::pkg_remove\b|\brenv::remove\b/.test(code)) {
        operation = "package_remove"
        manager = code.includes("renv::") ? "renv" : code.includes("pak::") ? "pak" : "remove.packages"
      } else if (/\bupdate\.packages\b|\brenv::(?:update|restore|init|snapshot)\b/.test(code)) {
        operation = "environment_update"
        manager = code.includes("renv::") ? "renv" : "update.packages"
      }
    }

    if (!operation || !manager) return
    const digest = createHash("sha256")
      .update(JSON.stringify({ language: input.language, environment: input.environment, operation, code: input.code }))
      .digest("hex")
    return {
      language: input.language,
      environment: input.environment,
      operation,
      manager,
      digest,
      restart: true,
    }
  }

  /** Stable, app-managed package root used when no project interpreter owns a
   * package directory. It is project + language + environment scoped, so
   * child sessions share installed packages but never interpreter state. */
  export function managedRoot(language: Language, environment: string) {
    return path.join(Global.Path.data, "kernel-environments", Instance.project.id, language, environment)
  }

  /** Resolve the complete Python start contract for both the canonical tool
   * and HTTP runtime surface. A host interpreter is paired with an app-owned
   * package root; a selected virtual environment owns its package directory. */
  export async function pythonRuntime(environment: string, allowMutation = false): Promise<KernelStartOptions> {
    const runtime = await pythonEnvironment(Instance.directory, environment)
    const virtualEnvironment = runtime.env?.VIRTUAL_ENV
    if (virtualEnvironment) {
      return {
        ...runtime,
        ...(allowMutation ? { extraWritable: [virtualEnvironment], sandboxNetwork: "allow" as const } : {}),
      }
    }

    const packages = path.join(managedRoot("python", environment), "site-packages")
    if (allowMutation) mkdirSync(packages, { recursive: true })
    return {
      ...runtime,
      env: {
        ...(runtime.env ?? {}),
        PIP_TARGET: packages,
        PYTHONPATH: [packages, runtime.env?.PYTHONPATH, process.env.PYTHONPATH].filter(Boolean).join(path.delimiter),
      },
      ...(allowMutation ? { extraWritable: [packages], sandboxNetwork: "allow" as const } : {}),
    }
  }

  /** Complete R start contract shared by all canonical entry points. */
  export function rRuntime(allowMutation = false): KernelStartOptions {
    const packages = path.join(managedRoot("r", "r"), "library")
    if (allowMutation) mkdirSync(packages, { recursive: true })
    return {
      environmentName: "r",
      env: { R_LIBS_USER: packages },
      ...(allowMutation ? { extraWritable: [packages], sandboxNetwork: "allow" as const } : {}),
    }
  }

  export function permission(plan: Plan) {
    return {
      permission: "environment_mutation",
      patterns: [plan.digest],
      always: [plan.digest],
      metadata: {
        environment_mutation: {
          language: plan.language,
          environment: plan.environment,
          operation: plan.operation,
          manager: plan.manager,
          plan_digest: plan.digest,
          restart: plan.restart,
          warning:
            "This may contact package repositories and changes packages in the selected environment. The affected runtime restarts after a successful change, so in-memory variables are cleared.",
        },
      },
    }
  }
}
