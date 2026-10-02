import { ConnectorFormError } from "./form-error"

export function parseConnectorCommand(input: string): string[] {
  const state = {
    quote: "",
    escape: false,
    token: "",
    started: false,
  }
  const result: string[] = []
  const push = () => {
    if (!state.started) return
    result.push(state.token)
    state.token = ""
    state.started = false
  }

  for (const char of input.trim()) {
    if (state.escape) {
      state.token += char
      state.escape = false
      state.started = true
      continue
    }
    if (char === "\\" && state.quote !== "'") {
      state.escape = true
      continue
    }
    if (state.quote) {
      if (char === state.quote) {
        state.quote = ""
        continue
      }
      state.token += char
      continue
    }
    if (char === '"' || char === "'") {
      state.quote = char
      state.started = true
      continue
    }
    if (/\s/u.test(char)) {
      push()
      continue
    }
    state.token += char
    state.started = true
  }

  if (state.escape) throw new ConnectorFormError("settings.validation.escape")
  if (state.quote) throw new ConnectorFormError("settings.validation.quote", { quote: state.quote })
  push()
  return result
}

export function formatConnectorCommand(command: string[]): string {
  return command
    .map((value) => {
      if (/^[a-zA-Z0-9_./:@%+=,-]+$/u.test(value)) return value
      return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`
    })
    .join(" ")
}
