// Binary units, one decimal below 10 of the unit: matches attachmentSize in
// @/components/prompt-attachment so a size reads the same everywhere.
export const bytes = (value?: number) => {
  if (value === undefined) return "—"
  if (value < 1_024) return `${Math.round(value)} B`
  if (value < 1_024 * 1_024) return `${(value / 1_024).toFixed(value < 10 * 1_024 ? 1 : 0)} KB`
  if (value < 1_024 * 1_024 * 1_024)
    return `${(value / (1_024 * 1_024)).toFixed(value < 10 * 1_024 * 1_024 ? 1 : 0)} MB`
  return `${(value / (1_024 * 1_024 * 1_024)).toFixed(1)} GB`
}
