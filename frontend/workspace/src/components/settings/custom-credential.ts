export type CustomCredentialIdentity =
  { ok: true; id: string; field: string; label: string } | { ok: false; error: string }

export function customCredentialIdentity(labelInput: string, fieldInput: string): CustomCredentialIdentity {
  const label = labelInput.trim()
  if (!label) return { ok: false, error: "Enter a service name." }
  const slug = label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
  if (!slug || slug.length > 64) return { ok: false, error: "Use a service name with letters or numbers." }

  const field = (fieldInput.trim() || "api_key").toLowerCase()
  if (!/^[a-z][a-z0-9_]{0,63}$/.test(field)) {
    return { ok: false, error: "Environment fields must start with a letter and use only letters, numbers, or _." }
  }
  return { ok: true, id: `custom:${slug}`, field, label }
}
