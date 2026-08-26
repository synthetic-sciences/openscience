import z from "zod"

export namespace ComputeSecrets {
  export const Ref = z.enum(["nvidia_nim", "nvidia_ngc"])
  export type Ref = z.infer<typeof Ref>

  export type Fields = (service: string) => Promise<Record<string, string> | undefined>

  const SPECS: Record<Ref, { service: string; field: string; env: string }> = {
    nvidia_nim: { service: "nvidia", field: "api_key", env: "NVIDIA_API_KEY" },
    nvidia_ngc: { service: "nvidia_ngc", field: "api_key", env: "NGC_API_KEY" },
  }

  export async function available(resolve: Fields): Promise<Ref[]> {
    const refs = Ref.options
    const states = await Promise.all(
      refs.map(async (ref) => {
        const spec = SPECS[ref]
        const fields = await resolve(spec.service)
        return fields?.[spec.field] ? ref : undefined
      }),
    )
    return states.filter((ref): ref is Ref => !!ref)
  }

  /** Convert reviewed symbolic references into an ephemeral Modal secret.
   * Neither the references nor the durable Job record contain secret values. */
  export async function resolve(refs: Ref[], fields: Fields): Promise<Record<string, string>> {
    const values = await Promise.all(
      [...new Set(refs)].map(async (ref) => {
        const spec = SPECS[ref]
        const credential = await fields(spec.service)
        const value = credential?.[spec.field]
        if (!value) throw new Error(`Compute secret reference ${ref} is not configured`)
        return [spec.env, value] as const
      }),
    )
    return Object.fromEntries(values)
  }
}
