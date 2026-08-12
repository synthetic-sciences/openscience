export type NetworkDomainResult = { ok: true; domain: string } | { ok: false; error: string }

export function canonicalNetworkDomain(input: string): NetworkDomainResult {
  if (!input) return { ok: false, error: "Enter a domain name." }
  if (input !== input.trim() || /\s/.test(input)) {
    return { ok: false, error: "Domains cannot contain whitespace." }
  }
  if (/[\/@:?#*]/.test(input)) {
    return { ok: false, error: "Enter a bare hostname without a scheme, path, port, credentials, or wildcard." }
  }

  const lower = input.toLowerCase()
  const withoutDot = lower.endsWith(".") ? lower.slice(0, -1) : lower
  if (!withoutDot || withoutDot.endsWith(".")) return { ok: false, error: "Enter a valid DNS hostname." }
  // Reject decimal-looking forms before URL parsing can normalize shorthand
  // such as 127.1 into an IP literal.
  if (/^\d+(?:\.\d+)*$/.test(withoutDot)) return { ok: false, error: "IP addresses are not allowed." }

  let hostname: string
  try {
    hostname = new URL(`http://${withoutDot}`).hostname.toLowerCase()
  } catch {
    return { ok: false, error: "Enter a valid DNS hostname." }
  }
  if (hostname === "localhost" || hostname.endsWith(".localhost") || hostname.endsWith(".local")) {
    return { ok: false, error: "Local hostnames are not allowed." }
  }
  if (!hostname.includes(".")) return { ok: false, error: "Enter a fully qualified hostname." }
  if (/^(?:\d{1,3}\.){3}\d{1,3}$/.test(hostname) || hostname.includes(":")) {
    return { ok: false, error: "IP addresses are not allowed." }
  }
  if (hostname.length > 253) return { ok: false, error: "The hostname is too long." }
  const labels = hostname.split(".")
  if (
    labels.some(
      (label) =>
        !label || label.length > 63 || !/^[a-z0-9-]+$/.test(label) || label.startsWith("-") || label.endsWith("-"),
    )
  ) {
    return { ok: false, error: "Enter a valid DNS hostname." }
  }
  return { ok: true, domain: hostname }
}
