// The local openscience server only ever binds to loopback. Two independent checks
// gate every NETWORK request (in-process callers bypass both via a per-process
// nonce header — see Server.internalFetch):
//
//   isAllowedHost   — rejects DNS-rebinding. An attacker page on evil.com that
//     rebinds its domain to 127.0.0.1 still sends `Host: evil.com`; browsers
//     cannot forge the Host header, so only loopback hosts pass. Bun derives
//     the request URL from the Host header, so deriving the host from the URL
//     (for the rare header-less client) is equally safe.
//
//   isAllowedOrigin — rejects plain cross-origin requests AND cross-origin
//     WebSocket upgrades (which CORS does not cover). A page on evil.com that
//     fetches http://localhost:<port> directly sends `Host: localhost` (passing
//     the host check) but `Origin: https://evil.com`. Only the local UI, the
//     desktop (tauri) shell, *.syntheticsciences.ai, and configured CORS
//     domains are allowed. This MUST stay in lockstep with the cors() policy
//     in server.ts (the cors middleware reuses this function).

const ALLOWED_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"])

// Apex domains whose https subdomains are trusted for CORS/WebSocket origins.
// The hosted web UI lives on <subdomain>.syntheticsciences.ai; forks and
// self-hosters add their own via OPENSCIENCE_CORS_DOMAINS (comma-separated apexes,
// e.g. "example.org,foo.dev"). Loopback + tauri stay auto-trusted regardless.
const DEFAULT_CORS_DOMAINS = ["syntheticsciences.ai"]

function allowedApexDomains(): string[] {
  const configured = (process.env["OPENSCIENCE_CORS_DOMAINS"] ?? "")
    .split(",")
    .map((domain) => domain.trim().toLowerCase())
    .filter(Boolean)
  return [...DEFAULT_CORS_DOMAINS, ...configured]
}

function matchesAllowedSubdomain(origin: string): boolean {
  for (const apex of allowedApexDomains()) {
    const escaped = apex.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    // <subdomain>.<apex> (https only). The bare apex is NOT trusted (it may
    // carry marketing pages / third-party tags), so a subdomain label is
    // required (`+`, not `*`).
    if (new RegExp(`^https://[a-z0-9-]+\\.${escaped}$`).test(origin)) return true
  }
  return false
}

export function isAllowedHost(hostHeader: string | undefined): boolean {
  if (!hostHeader) return false
  const host = hostHeader.startsWith("[")
    ? hostHeader.slice(0, hostHeader.indexOf("]") + 1) // keep "[::1]" bracket form
    : hostHeader.split(":")[0]
  return ALLOWED_HOSTS.has(host)
}

export function isAllowedOrigin(origin: string, extraWhitelist: string[] = []): boolean {
  if (origin.startsWith("http://localhost:") || origin === "http://localhost") return true
  if (origin.startsWith("http://127.0.0.1:") || origin === "http://127.0.0.1") return true
  if (origin === "tauri://localhost" || origin === "http://tauri.localhost") return true
  // Trusted hosted-UI subdomains (default syntheticsciences.ai, extended via
  // OPENSCIENCE_CORS_DOMAINS). See matchesAllowedSubdomain.
  if (matchesAllowedSubdomain(origin)) return true
  return extraWhitelist.includes(origin)
}

// Decide whether a NETWORK request is cross-origin and must be rejected. An
// Origin header (always present on cross-origin fetch and WebSocket upgrades)
// is checked against the allow-list; when it is absent (same-origin requests
// and same-/cross-site GET navigations omit it) we fall back to Sec-Fetch-Site
// and reject only explicit cross-site contexts. Non-browser clients send
// neither header and are allowed (the loopback bind already gates them).
export function isCrossOrigin(
  origin: string | undefined,
  secFetchSite: string | undefined,
  extraWhitelist: string[] = [],
): boolean {
  if (origin !== undefined) return !isAllowedOrigin(origin, extraWhitelist)
  return secFetchSite === "cross-site"
}
