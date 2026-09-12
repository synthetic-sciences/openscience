import type { PermissionNext } from "@/permission/next"
import { Skill } from "@/skill/skill"
import { BIOLOGY_TOOL_IDS } from "@/tool/biology"
import PROMPT_BIOLOGY from "./prompt/biology.txt"
import PROMPT_CHEMISTRY from "./prompt/chemistry.txt"
import PROMPT_CRITIQUE from "./prompt/critique.txt"
import PROMPT_ML from "./prompt/ml.txt"
import PROMPT_PHYSICS from "./prompt/physics.txt"

/**
 * Domain specialists the lead Research agent can delegate to. A specialist is
 * the ordinary Research runtime plus three things: a domain contract, the
 * full index of its library categories (too long to carry in the lead's
 * prompt, fine inside a worker), and the domain tools unlocked.
 */
export namespace Specialist {
  export const NAMES = ["ml", "biology", "physics", "chemistry", "critique"] as const
  export type Name = (typeof NAMES)[number]

  type Profile = {
    label: string
    when: string
    categories: string[]
    preamble: string
    /** Tools the worker gets without loading a skill first. */
    tools: readonly string[]
    /** Tools the worker must not have; a reviewer stays read-only. */
    deny?: readonly string[]
  }

  export const profiles: Record<Name, Profile> = {
    ml: {
      label: "ML specialist",
      when: "training, fine-tuning, evaluation, inference serving, interpretability, or GPU compute setup",
      categories: ["ml-training", "llm-tools", "ml-inference", "cloud-compute", "data-engineering"],
      preamble: PROMPT_ML,
      tools: [],
    },
    biology: {
      label: "Biology specialist",
      when: "sequences, omics, structures, pathways, or biological databases",
      categories: ["biology", "databases"],
      preamble: PROMPT_BIOLOGY,
      tools: [...BIOLOGY_TOOL_IDS],
    },
    physics: {
      label: "Physics specialist",
      when: "simulation, numerical methods, dynamical systems, or physical data analysis",
      categories: ["physics", "quantum"],
      preamble: PROMPT_PHYSICS,
      tools: [],
    },
    chemistry: {
      label: "Chemistry specialist",
      when: "molecules, cheminformatics, docking, property prediction, or chemical databases",
      categories: ["chemistry", "databases"],
      preamble: PROMPT_CHEMISTRY,
      tools: [],
    },
    critique: {
      label: "Critique reviewer",
      when: "an independent, read-only critical review of a draft, analysis, code or result, reporting BLOCKING issues and observations",
      categories: [],
      preamble: PROMPT_CRITIQUE,
      tools: [],
      deny: ["write", "edit", "apply_patch", "bash", "compute_job", "generate_image", "study"],
    },
  }

  export function is(value: string): value is Name {
    return (NAMES as readonly string[]).includes(value)
  }

  function sentence(text: string) {
    const first = text.split(/(?<=[.!?])\s+/)[0] ?? text
    return first.length > 140 ? `${first.slice(0, 137)}...` : first
  }

  /** The `<domain-skills>` index: every skill in the specialist's categories,
   * one line each, grouped by category. */
  export async function index(name: Name, permission: PermissionNext.Ruleset) {
    const profile = profiles[name]
    const catalog = (await Skill.catalog(permission)).allowed
    const groups = profile.categories
      .map((category) => ({
        category,
        skills: catalog.filter((skill) => skill.category === category).sort((a, b) => a.name.localeCompare(b.name)),
      }))
      .filter((group) => group.skills.length)
    if (!groups.length) return
    return [
      "<domain-skills>",
      `Your domain library. Load a skill with skill({name}) when its procedure applies; load one at a time and do not narrate the load.`,
      ...groups.flatMap((group) => [
        `${group.category}:`,
        ...group.skills.map((skill) => `- ${skill.name}: ${skill.summary ?? sentence(skill.description)}`),
      ]),
      "</domain-skills>",
    ].join("\n")
  }

  /** System guidance for a specialist worker: the domain contract, then its
   * skill index. The tags around the bundled contract are stripped so the
   * text reads as ordinary system context. */
  export async function guidance(name: Name, permission: PermissionNext.Ruleset) {
    const profile = profiles[name]
    const contract = profile.preamble.replace(/<\/?system-reminder>/gu, "").trim()
    const skills = await index(name, permission)
    return [contract, ...(skills ? [skills] : [])].join("\n\n")
  }

  /** Tool overrides for a specialist worker: its domain tools on, and for a
   * reviewer the mutating tools off. */
  export function tools(name: Name): Record<string, boolean> {
    const profile = profiles[name]
    return {
      ...Object.fromEntries(profile.tools.map((tool) => [tool, true])),
      ...Object.fromEntries((profile.deny ?? []).map((tool) => [tool, false])),
    }
  }
}
