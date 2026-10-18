export type Route = { section: "openscience"; path: string; anchor?: string }

// Pages live at /docs/<page>. Before that they lived at /docs/#/openscience/<page>,
// and those links (in the CLI, the apps, READMEs) still resolve through parseRoute.
export const BASE = "/docs"
export const SITE = "https://www.openscience.sh"

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

function route(location: string, anchor: string | undefined): Route {
  const path = location.replace(/^(openscience|agent-cli|cli)(\/|$)/, "") || "index"
  return {
    section: "openscience",
    path: Object.hasOwn(aliases, path) ? aliases[path] : path,
    ...(anchor ? { anchor } : {}),
  }
}

/* Accepts a docs path ("/docs/sessions#exit-codes") or a legacy hash route
   ("#/openscience/sessions#exit-codes", "#sessions"). */
export function parseRoute(location: string): Route {
  if (location.startsWith("#")) {
    const raw = location.replace(/^#\/?/, "")
    const split = raw.indexOf("#")
    const path = decode(split < 0 ? raw : raw.slice(0, split)).replace(/\/$/, "")
    return route(path, split < 0 ? undefined : decode(raw.slice(split + 1)) || undefined)
  }
  const split = location.indexOf("#")
  const pathname = split < 0 ? location : location.slice(0, split)
  const path = decode(pathname)
    .replace(new RegExp("^" + BASE + "(?=/|$)"), "")
    .replace(/^\/+|\/+$/g, "")
  return route(path, split < 0 ? undefined : decode(location.slice(split + 1)) || undefined)
}

// Where an old link now lives: /docs/#/openscience/<page>, /docs/#<renamed page>, or /docs/<renamed page>.
export function movedHref(pathname: string, hash: string): string | null {
  const atRoot = new RegExp("^" + BASE + "/?$").test(pathname)
  if (hash.startsWith("#/") || (atRoot && Object.hasOwn(aliases, decode(hash.slice(1))))) {
    const target = parseRoute(hash)
    return pageHref(target.section, target.path, target.anchor)
  }
  const leaf = decode(pathname)
    .replace(new RegExp("^" + BASE + "/?"), "")
    .replace(/\/+$/, "")
  return Object.hasOwn(aliases, leaf) ? pageHref("openscience", aliases[leaf]) + hash : null
}

export function pageHref(_section: Route["section"], path: string, anchor?: string): string {
  return (path === "index" ? BASE : BASE + "/" + path) + (anchor ? "#" + encodeURIComponent(anchor) : "")
}

export function pageUrl(path: string): string {
  return SITE + pageHref("openscience", path)
}

// Search results show about 60 characters of a title; the suffix gives way first.
export function documentTitle(title: string, path?: string): string {
  if (path === "index") return "OpenScience Docs"
  for (const candidate of [title + " · OpenScience Docs", title + " · OpenScience"]) {
    if (candidate.length <= 60) return candidate
  }
  return title
}

export function resolveLink(href: string | undefined, current: Route): string | undefined {
  if (!href || /^(?:https?:|mailto:|tel:)/.test(href)) return href
  if (href.startsWith("#") && !href.startsWith("#/")) {
    return pageHref(current.section, current.path, decode(href.slice(1)))
  }
  const target = parseRoute(href.startsWith("#") ? href : "/" + href.replace(/^\//, ""))
  return pageHref(target.section, target.path.replace(/\.(mdx|md)$/, ""), target.anchor)
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
