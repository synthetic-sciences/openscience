import path from "path"
import z from "zod"
import { Global } from "../global"
import { JsonStore } from "../util/jsonstore"

export namespace ComputePrompt {
  const skills = new Set(["modal-serverless-gpu", "modal-ml-training", "modal-research-gpu"])
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
      return "Modal compute is configured and enabled through OpenScience. It is available through the governed `compute_job` JobBroker for explicitly approved jobs in isolated Modal sandboxes."
    })()

    return [
      "<compute-capability>",
      state,
      "JobBroker compute contract:",
      "- Questions about whether Modal is available, configured, connected, or enabled are read-only. Answer them only from the capability state above. Never dispatch a job to test availability.",
      "- Discover targets and plan or start every detached local, SSH, scheduler, or Modal workload through `compute_job`. Its immutable plan card is the approval request for remote work. Do not first present a prose approval card or wait for chat confirmation; a chat reply such as `yes` is not dispatch authorization. Do not dispatch through provider CLIs, SDKs, or separate cloud-compute tools.",
      "- Do not check for or install the Modal Python package. Never run or recommend `modal run`, `modal setup`, or `pip install modal`.",
      "- Modal runs through OpenScience's JavaScript control-plane adapter. Credentials are not available in the agent shell.",
      "- A Modal job command is an ordinary shell command that runs inside the configured sandbox image, such as `python analysis.py`; it is not a Modal CLI launcher or a Modal-decorated Python application.",
      '- When asked to run work on Modal, prepare ordinary workspace files, then call `compute_job` with target `{ kind: "modal" }`, the command, explicit uploads and artifacts, Python packages, image, GPU, and resource limits. Use GPU `none` for CPU-only work.',
      `- The configured default is ${timeout} minutes. Use it as the starting point, then choose an explicit \`resources.time_minutes\` that fits the expected workload and include it in the tool call. Do not ask the user to choose unless they specified a time or spending constraint. The approval card shows the resulting \`timeout_minutes\` limit.`,
      "- Put third-party Python dependencies in the tool's `packages` field, preferably pinned. Do not assume the configured base image contains scientific packages.",
      "- Only report dispatch, status, logs, or completion returned by `compute_job`. Do not invent a precise cost or duration estimate.",
      "- For an existing job, use `compute_job` to list project jobs or inspect status, logs, and delivered artifacts. Read-only inspection must never dispatch a test job. Use its governed cancellation, retry-delivery, or release actions only when the user requests that lifecycle change.",
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
      "# OpenScience-governed Modal compute",
      "",
      capability,
      "",
      "This runtime uses Modal as a governed sandbox provider, not as an agent-controlled Python SDK or CLI.",
      'For ordinary runs, prepare normal project files and call `compute_job` with target `{ kind: "modal" }` and an ordinary shell command. Use `python analysis.py`, list `analysis.py` in `uploads`, list third-party requirements in `packages`, use GPU `none` for CPU-only work, and choose an explicit `resources.time_minutes` from the expected runtime plus a reasonable safety margin. The JobBroker owns review, dispatch, job state, and logs.',
      "Do not inspect credential environment variables or ~/.modal.toml. Do not install or invoke Modal, write a Modal-decorated application, present a prose approval card, ask for chat approval, or send the user to manually recreate the job in Compute. Once the files and parameters are ready, call `compute_job` immediately and let its governed card request approval.",
      "The cached skill content and its reference files describe a legacy direct-SDK integration and are intentionally superseded for this OpenScience runtime. If the user explicitly wants to author an independent Modal Python application, explain that it is a separate workflow outside governed OpenScience Compute; provide conceptual help only and do not execute it here.",
    ].join("\n")
  }
}
