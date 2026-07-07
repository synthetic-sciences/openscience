import type { Argv } from "yargs"
import { Instance } from "../../project/instance"
import { Provider } from "../../provider/provider"
import { ModelsDev } from "../../provider/models"
import { cmd } from "./cmd"
import { UI } from "../ui"
import { EOL } from "os"

const PROVIDER_LABELS: Record<string, string> = {
  anthropic: "Anthropic",
  openai: "OpenAI",
  "openai-codex": "OpenAI Codex",
  google: "Google",
  gemini: "Google Gemini",
  openrouter: "OpenRouter",
}

/** Classify a provider as BYOK, openscience-managed, OAuth, or unknown.
 *
 *  Detection rules:
 *  - openai-codex routes via OAuth (Sign in with ChatGPT), neither.
 *  - key starts with "thk_" → managed (the proxy thumbprint Atlas hands
 *    out on /api/cli/sync when the user has no BYOK key set).
 *  - options.baseURL points at Atlas (/api/llm/proxy/) → managed.
 *  - anything else with a key → BYOK.
 */
function routingLabel(providerID: string, provider: Provider.Info): string {
  if (providerID === "openai-codex") return "Signed in with Codex"
  const key = (provider.key ?? "").toLowerCase()
  if (key.startsWith("thk_")) return "managed"
  const baseURL = (provider.options?.baseURL as string | undefined) ?? ""
  if (baseURL.includes("/api/llm/proxy/")) return "managed"
  // A config-registered local endpoint stores its key under options.apiKey (not
  // provider.key), so it would otherwise read as "unconfigured".
  if (Provider.isLocalBaseURL(baseURL)) return "local"
  if (provider.key) return "your key"
  return "unconfigured"
}

function prettyProviderName(providerID: string): string {
  return PROVIDER_LABELS[providerID] ?? providerID
}

export const ModelsCommand = cmd({
  command: "model [provider]",
  aliases: ["models"],
  describe: "list all available models",
  builder: (yargs: Argv) => {
    return yargs
      .positional("provider", {
        describe: "provider ID to filter models by",
        type: "string",
        array: false,
      })
      .option("verbose", {
        describe: "use more verbose model output (includes metadata like costs)",
        type: "boolean",
      })
      .option("refresh", {
        describe: "refresh the models cache from models.dev",
        type: "boolean",
      })
      .option("flat", {
        describe: "print one provider/model id per line (legacy format)",
        type: "boolean",
      })
  },
  handler: async (args) => {
    if (args.refresh) {
      await ModelsDev.refresh()
      UI.println(UI.Style.TEXT_SUCCESS_BOLD + "Models cache refreshed" + UI.Style.TEXT_NORMAL)
    }

    await Instance.provide({
      directory: process.cwd(),
      async fn() {
        const providers = await Provider.list()

        function printFlat(providerID: string, verbose?: boolean) {
          const provider = providers[providerID]
          const sortedModels = Object.entries(provider.models).sort(([a], [b]) => a.localeCompare(b))
          for (const [modelID, model] of sortedModels) {
            process.stdout.write(`${providerID}/${modelID}`)
            process.stdout.write(EOL)
            if (verbose) {
              process.stdout.write(JSON.stringify(model, null, 2))
              process.stdout.write(EOL)
            }
          }
        }

        function printGrouped(providerID: string, verbose?: boolean) {
          const provider = providers[providerID]
          const sortedModels = Object.entries(provider.models).sort(([a], [b]) => a.localeCompare(b))
          if (sortedModels.length === 0) return
          const label = routingLabel(providerID, provider)
          const name = prettyProviderName(providerID)
          process.stdout.write(`${UI.Style.TEXT_HIGHLIGHT_BOLD}${name}${UI.Style.TEXT_NORMAL} (${label})` + EOL)
          for (const [modelID, model] of sortedModels) {
            process.stdout.write(`    ${modelID}` + EOL)
            if (verbose) {
              process.stdout.write(JSON.stringify(model, null, 2) + EOL)
            }
          }
          process.stdout.write(EOL)
        }

        if (args.provider) {
          const provider = providers[args.provider]
          if (!provider) {
            UI.error(`Provider not found: ${args.provider}`)
            return
          }
          if (args.flat) {
            printFlat(args.provider, args.verbose)
          } else {
            printGrouped(args.provider, args.verbose)
          }
          return
        }

        const providerIDs = Object.keys(providers).sort((a, b) => {
          const aIsManaged = a.startsWith("synsci")
          const bIsManaged = b.startsWith("synsci")
          if (aIsManaged && !bIsManaged) return -1
          if (!aIsManaged && bIsManaged) return 1
          return a.localeCompare(b)
        })

        const printer = args.flat ? printFlat : printGrouped
        for (const providerID of providerIDs) {
          printer(providerID, args.verbose)
        }
      },
    })
  },
})
