import { Skill } from "@/skill"

/**
 * Runtime resolution of how GPU compute is funded.
 *
 * `billing.compute` used to answer this from config alone, which meant a
 * brand-new user with zero provider keys resolved to "byok" — claiming BYOK
 * with nothing to BYOK with. This module answers it from the environment
 * instead, and can say "none", which is the state we previously handled worst.
 *
 * Resolution deliberately happens ON DEMAND and never at startup. Provider keys
 * reach process.env from three places — the user's shell, the Credentials panel
 * (`applyCredentialEnv`, src/index.ts:102) and the Compute panel
 * (`applyComputeEnv`, src/index.ts:106) — and the latter two are wrapped in
 * `.catch(() => {})`. Detecting at boot would report "none" for a user whose
 * keys are configured through the UI. Both call sites (SkillTool.init and the
 * compute_status tool) run per request, long after those injections, so the
 * ordering constraint cannot be violated and cannot silently regress if someone
 * reorders src/index.ts later.
 */
export namespace ComputeMode {
  export type Source = "byok" | "managed" | "none"

  /**
   * A provider is BYOK-usable only with BOTH a credential and a skill: the agent
   * runs GPU work by loading a provider's skill, so a key with no skill gives it
   * nothing to act on.
   *
   * `env` is a list of ALTERNATIVE groups; a group is satisfied when every var in
   * it is set and non-empty. Modal is the only pair — its single pasted key
   * splits into a token id + secret, and a half-pasted one maps to nothing
   * (mirroring `mapProviderEnv`, server/routes/settings/compute.ts:181).
   *
   * `skills` are frontmatter `name` values, NOT directory names and NOT
   * category-prefixed. Only these names are subject to mode filtering; the other
   * cloud-compute skills (tinker, skypilot, fireworks, together) are inference
   * APIs and orchestrators keyed by their own credentials, not GPU leases this
   * mode governs, and are never hidden.
   */
  export const PROVIDERS: Record<string, { env: string[][]; skills: string[] }> = {
    modal: {
      env: [["MODAL_TOKEN_ID", "MODAL_TOKEN_SECRET"]],
      skills: ["modal-serverless-gpu", "modal-ml-training", "modal-research-gpu"],
    },
    lambda: {
      env: [["LAMBDA_API_KEY"], ["LAMBDA_LABS_API_KEY"]],
      skills: ["lambda-labs-gpu-cloud"],
    },
    tensorpool: {
      env: [["TENSORPOOL_KEY"], ["TENSORPOOL_API_KEY"]],
      skills: ["tensorpool-gpu-cloud"],
    },
    prime: {
      env: [["PRIME_API_KEY"], ["PRIME_INTELLECT_API_KEY"]],
      skills: ["prime-intellect-lab"],
    },
    runpod: {
      env: [["RUNPOD_API_KEY"]],
      skills: ["runpod-gpu-cloud"],
    },
    vast: {
      env: [["VAST_API_KEY"]],
      skills: ["vast-ai-gpu-cloud"],
    },
  }

  /** Every provider skill name — the exact set the catalog filter operates on. */
  export const SKILLS = new Set(Object.values(PROVIDERS).flatMap((p) => p.skills))

  /** Read process.env directly rather than Env.get: applyComputeEnv writes to
   *  process.env first and mirrors to Env only when instance state exists, so
   *  process.env is the one source that is always populated. */
  function keyed(groups: string[][]): boolean {
    return groups.some((group) => group.every((name) => !!process.env[name]))
  }

  /**
   * Split configured providers into those the agent can actually act on and
   * those with a stored key but no catalogued skill. The second list exists so
   * `none` can say *why* — a user who connected a key and is then told no
   * compute is available deserves better than silence.
   */
  export async function usable() {
    const catalog = new Set(await Skill.all().then((all) => all.map((skill) => skill.name)))
    const providers: string[] = []
    const unusable: string[] = []
    for (const [id, spec] of Object.entries(PROVIDERS)) {
      if (!keyed(spec.env)) continue
      if (spec.skills.some((name) => catalog.has(name))) providers.push(id)
      else unusable.push(id)
    }
    return { providers, unusable }
  }
}
