import path from "path"
import z from "zod"
import { Global } from "../global"
import { JsonStore } from "../util/jsonstore"

export namespace ComputePrompt {
  const skills = new Set(["modal-serverless-gpu"])
  const Stored = z
    .object({
      providers: z
        .record(
          z.string(),
          z
            .object({
              enabled: z.boolean().default(false),
            })
            .passthrough(),
        )
        .default({}),
      modal: z
        .object({
          timeout_minutes: z
            .number()
            .int()
            .min(1)
            .max(24 * 60)
            .default(60),
        })
        .default({ timeout_minutes: 60 }),
    })
    .passthrough()

  const filepath = path.join(Global.Path.data, "settings-compute.json")

  export function render(value: unknown) {
    const parsed = Stored.safeParse(value)
    const modal = parsed.success ? parsed.data.providers.modal : undefined
    const timeout = parsed.success ? parsed.data.modal.timeout_minutes : 60
    const state = (() => {
      if (!modal) {
        return "Modal is not configured in OpenScience. Direct the user to Settings > Compute to configure it before claiming that Modal jobs are available."
      }
      if (!modal.enabled) {
        return "Modal is configured but disabled in OpenScience, so it is not available for new jobs. The user can enable it in Settings > Compute."
      }
      return "Modal compute is configured and enabled through OpenScience for explicitly approved jobs through governed `compute_job` in isolated sandboxes."
    })()

    return [
      "<compute-capability>",
      state,
      "JobBroker rules:",
      "- Questions about whether Modal is available, configured, connected, or enabled are read-only; answer from the state above. Never dispatch a job to test availability.",
      "- Plan or start every detached local, SSH, scheduler, or Modal workload through `compute_job`. Its immutable card requests remote approval; prose/chat approval does not: a chat reply such as `yes` is not dispatch authorization. Never use provider CLIs, SDKs, or other cloud tools.",
      "- Do not check for or install the Modal Python package. Never run or recommend `modal run`, `modal setup`, or `pip install modal`.",
      "- Modal uses OpenScience's JavaScript adapter. Credentials are not available in the agent shell.",
      "- A Modal command is an ordinary shell command that runs inside the configured sandbox image, not a Modal CLI launcher or decorated Python app.",
      '- For Modal, prepare workspace files and call `compute_job` with target `{ kind: "modal" }`, command, explicit uploads and artifacts, `packages`, image, GPU, and limits. Use GPU `none` for CPU-only work.',
      `- The configured default is ${timeout} minutes. Use it as the starting point; choose an explicit \`resources.time_minutes\` for expected runtime. Ask only about user-specified time/spend constraints. The card shows the resulting \`timeout_minutes\` limit.`,
      "- Put third-party Python dependencies in the `packages` field, preferably pinned; do not assume the base image includes them.",
      "- Only report dispatch, status, logs, or completion returned by `compute_job`. Do not invent a precise cost or duration estimate.",
      "- For existing jobs, use `compute_job` to list or inspect status, logs, and artifacts. Inspecting never dispatches; cancel, retry delivery, or release only when requested.",
      "</compute-capability>",
    ].join("\n")
  }

  export async function system(value?: unknown) {
    return render(value ?? (await JsonStore.read(filepath)))
  }

  export async function skill(name: string, content: string, value?: unknown) {
    if (!skills.has(name)) return content
    const capability = await system(value)
    return [
      "# User-owned Modal execution through OpenScience",
      "",
      capability,
      "",
      "This runtime uses the user's own Modal account as a reviewed sandbox target, not as an agent-controlled Python SDK or CLI and never as compute resold by OpenScience.",
      'For ordinary runs, prepare normal project files and call `compute_job` with target `{ kind: "modal" }` and an ordinary shell command. Use `python analysis.py`, list `analysis.py` in `uploads`, list third-party requirements in `packages`, use GPU `none` for CPU-only work, and choose an explicit `resources.time_minutes` from the expected runtime plus a reasonable safety margin. The JobBroker owns review, dispatch, job state, and logs.',
      "Do not inspect credential environment variables or ~/.modal.toml. Do not install or invoke Modal, write a Modal-decorated application, present a prose approval card, ask for chat approval, or send the user to manually recreate the job in Compute. Once the files and parameters are ready, call `compute_job` immediately and let its governed card request approval.",
      "If the user explicitly wants to author an independent Modal Python application, explain that it is a separate workflow outside OpenScience's reviewed job flow; provide conceptual help only and do not execute it here.",
    ].join("\n")
  }
}
