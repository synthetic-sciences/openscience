const known = new Set(["latest", "ci", "dev", "beta", "test"])

export function npmDistTag(version) {
  const value = String(version || "")
  const match = value.match(/^\d+\.\d+\.\d+-([0-9A-Za-z]+)(?:[.-]|$)/)
  const tag = match?.[1] || "latest"
  return known.has(tag) ? tag : "latest"
}

export function opensciencePackageSpec(version) {
  return `@synsci/openscience@${npmDistTag(version)}`
}
