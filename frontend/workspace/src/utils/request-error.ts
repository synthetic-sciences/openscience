export type RequestFailureKind = "health" | "transport" | "provider" | "ambiguous-create" | "request"

export type RequestFailure = {
  kind: RequestFailureKind
  title: string
  description: string
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : undefined
}

function field(value: unknown, key: string): unknown {
  return record(value)?.[key]
}

export function requestStatus(value: unknown): number | undefined {
  for (const item of [value, field(value, "data"), field(value, "error"), field(value, "response")]) {
    const status = field(item, "status") ?? field(item, "statusCode")
    if (typeof status === "number") return status
  }
}

function message(value: unknown): string {
  const options = [field(field(value, "data"), "message"), field(value, "message"), field(value, "error")]
  const found = options.find((item) => typeof item === "string" && item.trim())
  if (typeof found === "string") return found
  if (value instanceof Error && value.message) return value.message
  return "Request failed"
}

function names(value: unknown) {
  return [field(value, "name"), field(field(value, "data"), "name"), field(field(value, "error"), "name")]
    .filter((item): item is string => typeof item === "string")
    .join(" ")
}

export function requestFailure(
  error: unknown,
  action: string,
  options?: { ambiguousCreate?: boolean; candidate?: string },
): RequestFailure {
  const detail = message(error)
  if (options?.ambiguousCreate) {
    return {
      kind: "ambiguous-create",
      title: "Session creation is awaiting confirmation",
      description: `The server did not confirm whether the session was created${options.candidate ? ` (${options.candidate})` : ""}. Retry this saved draft; OpenScience will reuse the same session ID instead of creating a duplicate.`,
    }
  }

  const status = requestStatus(error)
  const identity = names(error)
  if (/provider|apierror/i.test(identity) || field(field(error, "data"), "providerID")) {
    return {
      kind: "provider",
      title: "Model provider request failed",
      description: `${detail} Your local server and saved project remain available; check the selected model connection before retrying.`,
    }
  }
  if (status !== undefined && status >= 500) {
    return {
      kind: "health",
      title: "Local server reported an error",
      description: `${detail} Check server health, then retry the saved request.`,
    }
  }
  if (
    status === undefined &&
    /failed to fetch|fetch failed|network|connection|econn|socket|offline|timed? ?out|timeout/i.test(detail)
  ) {
    return {
      kind: "transport",
      title: "Local server is unreachable",
      description: `${detail} Make sure the OpenScience server is running; your draft has been restored for retry.`,
    }
  }
  return { kind: "request", title: `${action} failed`, description: detail }
}
