export type Route = { section: "openscience"; path: string; anchor?: string }

export const aliases: Record<string, string> = {
  "first-session": "sessions",
  "sub-agents": "agents",
  "web-ui": "workspace",
  "server-mode": "workspace",
  "cli-runtime": "commands",
  "feature-map": "commands",
  codex: "models",
  credentials: "ace",
  connect: "ace",
  gateway: "ace",
  security: "permissions",
  sandbox: "permissions",
}

export function slug(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
}

function decode(value: string): string {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

export function parseRoute(hash: string): Route {
  const raw = hash.replace(/^#\/?/, "")
  const split = raw.indexOf("#")
  const location = decode(split < 0 ? raw : raw.slice(0, split)).replace(/\/$/, "")
  const anchor = split < 0 ? undefined : decode(raw.slice(split + 1)) || undefined
  const path = location.replace(/^(openscience|agent-cli|cli)(\/|$)/, "") || "index"
  return { section: "openscience", path: aliases[path] ?? path, ...(anchor ? { anchor } : {}) }
}

export function pageHref(section: Route["section"], path: string, anchor?: string): string {
  return "#/" + section + "/" + path + (anchor ? "#" + encodeURIComponent(anchor) : "")
}

export function resolveLink(href: string | undefined, current: Route): string | undefined {
  if (!href || /^(?:https?:|mailto:|tel:)/.test(href)) return href
  if (href.startsWith("#") && !href.startsWith("#/")) {
    return pageHref(current.section, current.path, decode(href.slice(1)))
  }
  const route = parseRoute(href.replace(/^\//, "#/"))
  return pageHref(route.section, route.path.replace(/\.(mdx|md)$/, ""), route.anchor)
}

export function headings(markdown: string, depth = 2): string[] {
  const state = { fence: "" }
  return markdown.split("\n").flatMap((line) => {
    const fence = line.match(/^\s*([\x60]{3,}|~{3,})/)
    if (fence) {
      if (!state.fence) state.fence = fence[1]
      else if (fence[1][0] === state.fence[0] && fence[1].length >= state.fence.length) state.fence = ""
      return []
    }
    const heading = line.match(/^(#{2,3}) (.+)$/)
    if (state.fence || !heading || heading[1].length > depth) return []
    return [heading[2].trim()]
  })
}
