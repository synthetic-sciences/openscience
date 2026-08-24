import z from "zod"

const RESERVED_METADATA = new Set(["review", "resolution"])

/** Metadata markers used by historical review records are read-only. Generic
 * provenance writers must not be able to manufacture records that the legacy
 * parser would interpret as findings or resolutions. */
export const WritableMetadata = z.record(z.string(), z.unknown()).superRefine((value, context) => {
  for (const key of Object.keys(value)) {
    if (!RESERVED_METADATA.has(key)) continue
    context.addIssue({
      code: "custom",
      path: [key],
      message: `Provenance metadata key "${key}" is reserved for historical review records`,
    })
  }
})
