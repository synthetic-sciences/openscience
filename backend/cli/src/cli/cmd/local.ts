import * as prompts from "@clack/prompts"
import type { Argv } from "yargs"
import { cmd } from "./cmd"
import { UI } from "../ui"
import { Instance } from "../../project/instance"
import { Config } from "../../config/config"
import { Provider } from "../../provider/provider"
import { LocalProvider } from "../../provider/local"

/** Options a caller (wizard, keys-add, onboarding) can pre-seed. */
export interface LocalSetupInput {
  /** Skip the intro banner (when embedded in another flow). */
  intro?: boolean
  /** Non-interactive: base URL of the endpoint (skips the runtime picker). */
  url?: string
  /** Non-interactive: model id(s) to register (skips discovery/selection). */
  models?: string[]
  /** Provider id to register under; derived when omitted. */
  id?: string
  /** Optional api key for the endpoint. */
  key?: string
  /** Write to the project config instead of the global (machine-wide) one. */
  project?: boolean
  /** Set the first added model as the default. */
  setDefault?: boolean
}

/** Derive a stable provider id from a base URL (host+port), e.g.
 *  http://localhost:11434/v1 → "local-11434". Falls back to "local". */
function deriveId(baseURL: string): string {
  try {
    const u = new URL(baseURL)
    const port = u.port || (u.protocol === "https:" ? "443" : "80")
    return `local-${port}`
  } catch {
    return "local"
  }
}

/**
 * Interactive (and scriptable) setup for a local OpenAI-compatible endpoint.
 * Detects running runtimes, discovers their models, writes the provider block to
 * config, and optionally sets a default. Returns the registered provider id, or
 * null if the user cancelled / nothing was added.
 */
export async function runLocalModelSetup(input: LocalSetupInput = {}): Promise<string | null> {
  return Instance.provide({
    directory: process.cwd(),
    async fn() {
      // Non-interactive when driven by flags (a url was supplied) or there's no
      // TTY (CI / piped). In that mode we NEVER prompt — discover + register with
      // sensible defaults, and error instead of blocking on input.
      const interactive = input.url === undefined && !!process.stdin.isTTY
      if (!interactive && !input.url) {
        prompts.log.error(
          "No endpoint to add. Pass --url http://localhost:11434/v1 (and optionally --model), or run interactively in a terminal.",
        )
        return null
      }
      if (input.intro !== false && interactive) prompts.intro("Add a local model")

      let baseURL: string
      let apiKey: string | undefined = input.key
      let presetId: string | undefined

      if (input.url) {
        baseURL = LocalProvider.normalizeBaseURL(input.url)
      } else {
        // Probe the well-known runtimes so we can offer "we found it" choices.
        const spin = prompts.spinner()
        spin.start("Looking for local model servers…")
        const detected = await LocalProvider.detect()
        spin.stop(
          detected.length ? `Found ${detected.length} running local server(s)` : "No running local server found",
        )

        const detectedIds = new Set(detected.map((d) => d.preset.id))
        const choice = await prompts.select({
          message: "Which local runtime?",
          options: [
            ...detected.map((d) => ({
              value: d.preset.id,
              label: `${d.preset.name}  ✓ running`,
              hint: `${d.models.length} model(s) · ${d.preset.baseURL}`,
            })),
            ...LocalProvider.PRESETS.filter((p) => !detectedIds.has(p.id)).map((p) => ({
              value: p.id,
              label: p.name,
              hint: p.hint,
            })),
            { value: "__custom__", label: "Custom OpenAI-compatible endpoint…", hint: "any http://host:port/v1" },
          ],
        })
        if (prompts.isCancel(choice)) return cancel()

        if (choice === "__custom__") {
          const url = await prompts.text({
            message: "Base URL of the endpoint",
            placeholder: "http://localhost:11434/v1",
            validate: (v) => (v && v.trim() ? undefined : "required"),
          })
          if (prompts.isCancel(url)) return cancel()
          baseURL = LocalProvider.normalizeBaseURL(url)
          const key = await prompts.text({
            message: "API key (leave blank if the server needs none)",
            placeholder: "(none)",
          })
          if (prompts.isCancel(key)) return cancel()
          apiKey = key.trim() || undefined
        } else {
          const preset = LocalProvider.PRESETS.find((p) => p.id === choice)!
          baseURL = preset.baseURL
          apiKey = apiKey ?? preset.apiKey
          presetId = preset.id
        }
      }

      // Discover models unless the caller specified them.
      let models = input.models ?? []
      let listFailed = false
      if (!models.length) {
        if (interactive) {
          const spin = prompts.spinner()
          spin.start(`Fetching models from ${baseURL}…`)
          try {
            models = await LocalProvider.listModels(baseURL, apiKey)
            spin.stop(models.length ? `Found ${models.length} model(s)` : "Endpoint returned no models")
          } catch (e) {
            listFailed = true
            spin.stop("Couldn't reach the endpoint", 1)
            prompts.log.warn(
              `${e instanceof Error ? e.message : String(e)}\n` +
                "Make sure the server is running (e.g. `ollama serve`), then retry — or enter a model id manually below.",
            )
          }
        } else {
          // Non-interactive: probe once; if it fails, that's fatal (no fallback prompt).
          models = (await LocalProvider.probe(baseURL, apiKey, 4000)) ?? []
          if (!models.length) {
            prompts.log.error(
              `Couldn't list models from ${baseURL}. Pass --model <id> to register one without discovery, ` +
                "or make sure the server is running.",
            )
            return null
          }
        }
      }

      let selected: string[] = models
      if (interactive && models.length && input.models === undefined) {
        const picked = await prompts.multiselect({
          message: "Which models do you want to add?",
          options: models.map((m) => ({ value: m, label: m })),
          initialValues: models,
          required: false,
        })
        if (prompts.isCancel(picked)) return cancel()
        selected = picked as string[]
      }

      if (!selected.length) {
        if (!interactive) {
          prompts.log.error("No models to add. Pass --model <id>.")
          return null
        }
        // No models discovered/selected — let the user name one directly.
        if (listFailed) prompts.log.info("Enter a model id to register anyway:")
        const one = await prompts.text({
          message: "Model id to add",
          placeholder: "llama3.1",
          validate: (v) => (v && v.trim() ? undefined : "required"),
        })
        if (prompts.isCancel(one)) return cancel()
        selected = [one.trim()]
      }

      const id = input.id ?? presetId ?? deriveId(baseURL)
      const name = presetId
        ? `${LocalProvider.PRESETS.find((p) => p.id === presetId)!.name} (local)`
        : `Local (${new URL(baseURL).host})`

      const block = LocalProvider.buildProviderConfig({ name, baseURL, apiKey, models: selected })
      await Config.setProvider(id, block as any, input.project ? "project" : "global")

      const scopeLabel = input.project ? "this project's openscience.json" : "your global config"
      prompts.log.success(`Added ${selected.length} model(s) under provider "${id}" to ${scopeLabel}.`)

      // Offer to set a default so `openscience run` uses it immediately.
      const firstModel = `${id}/${selected[0]}`
      const makeDefault =
        input.setDefault ??
        (interactive
          ? await (async () => {
              const yes = await prompts.confirm({
                message: `Set ${firstModel} as your default model?`,
                initialValue: true,
              })
              return !prompts.isCancel(yes) && yes
            })()
          : false)
      if (makeDefault) {
        // Set the default in the SAME scope as the provider block (global by
        // default) — never write into whatever project happens to be the cwd.
        if (input.project) await Config.update({ model: firstModel })
        else await Config.updateGlobal({ model: firstModel })
        prompts.log.info(`Default model set to ${firstModel}.`)
      }

      Provider.invalidate()
      if (input.intro !== false && interactive) prompts.outro("Done")
      prompts.log.message(`Use it now:  openscience run --model ${firstModel} "hello"`)
      return id

      function cancel(): null {
        prompts.cancel("Cancelled — no local model added.")
        return null
      }
    },
  })
}

const AddCommand = cmd({
  command: ["add", "$0"],
  describe: "add a local model endpoint (Ollama / LM Studio / OpenAI-compatible)",
  builder: (yargs: Argv) =>
    yargs
      .option("url", { type: "string", describe: "endpoint base URL, e.g. http://localhost:11434/v1" })
      .option("model", { type: "string", array: true, describe: "model id(s) to register (repeatable)" })
      .option("id", { type: "string", describe: "provider id to register under" })
      .option("key", { type: "string", describe: "api key, if the endpoint needs one" })
      .option("project", { type: "boolean", describe: "write to the project config instead of global" })
      .option("default", { type: "boolean", describe: "set the first model as the default" }),
  handler: async (args) => {
    UI.empty()
    await runLocalModelSetup({
      url: args.url as string | undefined,
      models: (args.model as string[] | undefined)?.length ? (args.model as string[]) : undefined,
      id: args.id as string | undefined,
      key: args.key as string | undefined,
      project: args.project as boolean | undefined,
      setDefault: args.default as boolean | undefined,
    })
  },
})

const ListCommand = cmd({
  command: "list",
  aliases: ["ls"],
  describe: "list configured local model providers",
  handler: async () => {
    await Instance.provide({
      directory: process.cwd(),
      async fn() {
        const config = await Config.get()
        const locals = Object.entries(config.provider ?? {}).filter(([, p]) =>
          Provider.isLocalBaseURL(p?.options?.baseURL ?? p?.api),
        )
        if (!locals.length) {
          UI.println("No local model providers configured. Add one with `openscience local add`.")
          return
        }
        for (const [id, p] of locals) {
          const url = (p?.options?.baseURL ?? p?.api) as string
          const models = Object.keys(p?.models ?? {})
          UI.println(`${UI.Style.TEXT_HIGHLIGHT_BOLD}${id}${UI.Style.TEXT_NORMAL}  ${url}`)
          for (const m of models) UI.println(`    ${id}/${m}`)
        }
      },
    })
  },
})

const RemoveCommand = cmd({
  command: "remove <id>",
  aliases: ["rm"],
  describe: "remove a local model provider",
  builder: (yargs: Argv) => yargs.positional("id", { type: "string", describe: "provider id to remove" }),
  handler: async (args) => {
    await Instance.provide({
      directory: process.cwd(),
      async fn() {
        const id = String(args.id)
        await Config.removeProvider(id, "global")
        await Config.removeProvider(id, "project")
        UI.println(`Removed local provider "${id}".`)
      },
    })
  },
})

export const LocalCommand = cmd({
  command: "local",
  describe: "manage local models (Ollama, LM Studio, OpenAI-compatible endpoints)",
  builder: (yargs: Argv) => yargs.command(AddCommand).command(ListCommand).command(RemoveCommand).demandCommand(0),
  handler: async () => {
    // Bare `openscience local` runs the add wizard (AddCommand is the $0 default,
    // but demandCommand(0) lets this handler run when no subcommand is given).
    UI.empty()
    await runLocalModelSetup({})
  },
})
