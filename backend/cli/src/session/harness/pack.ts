import z from "zod"

export namespace HarnessPack {
  export const Id = z.enum(["statistics", "biology", "physics", "pde", "chemistry", "ml", "forecast", "formal"])
  export type Id = z.infer<typeof Id>
}
