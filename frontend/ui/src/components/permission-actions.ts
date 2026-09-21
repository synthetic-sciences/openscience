import { iconDefinitions } from "./iconoir-registry"
import { useI18n } from "../context/i18n"

export type PermissionReply = "once" | "session" | "project" | "always" | "reject"

type Metadata = Record<string, any> | undefined

type Scope = { reply: Exclude<PermissionReply, "once" | "reject">; label: string; note?: string }
type Action = { reply: PermissionReply; label: string }

/**
 * Every request the agent raises is described the same way before it is
 * drawn: the thing being decided in one line, one quiet line of the facts a
 * person judges it by, the full rows behind a disclosure, and the same three
 * actions in the same order. The kinds differ in their words, not their shape.
 */
export type RequestModel = {
  kind:
    | "network"
    | "folder"
    | "fetch"
    | "search"
    | "remote-compute"
    | "ssh"
    | "environment-mutation"
    | "study"
    | "hosted-scientific"
    | "code"
    | "generic"
  title: string
  subline?: string
  rows: string[][]
  /** What the person should know before allowing (inside Details). */
  warning?: string
  /** What each scope covers for this kind (inside Details). */
  note?: string
  primary: Action
  /** A second one-off action beside the primary ("Only this request"). */
  secondary?: Action
  /** Standing scopes offered behind "Allow…"; none means the card is one-time. */
  scopes: Scope[]
  /** What choosing any scope adds, shown as the eyebrow while choosing. */
  scopeNote?: string
}

function hostedScientificLabel(id: string) {
  const labels: Record<string, string> = {
    boltz2: "Boltz-2",
    diffdock: "DiffDock",
    evo2: "Evo 2",
    genmol: "GenMol",
    molmim: "MolMIM",
    "msa-search": "MSA Search",
    openfold2: "OpenFold2",
    openfold3: "OpenFold3",
    proteinmpnn: "ProteinMPNN",
    rfdiffusion: "RFdiffusion",
  }
  if (labels[id]) return labels[id]
  return id
    .split(/[-_]/u)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ")
}

export function formatApprovalBytes(value: number) {
  const bytes = Math.max(0, Math.trunc(value))
  const exact = new Intl.NumberFormat("en-US").format(bytes)
  if (!Number.isFinite(value) || bytes < 1024) return `${exact} bytes`
  if (bytes < 1024 * 1024) return `${Number((bytes / 1024).toFixed(1))} KB (${exact} bytes)`
  return `${Number((bytes / (1024 * 1024)).toFixed(1))} MB (${exact} bytes)`
}

function shortBytes(value: number) {
  const bytes = Math.max(0, Math.trunc(value))
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${Number((bytes / (1024 * 1024)).toFixed(1))} MB`
}

function endpointHost(value: string) {
  try {
    return new URL(value).host
  } catch {
    return value
  }
}

function minutesLabel(minutes: number) {
  if (minutes % 60 === 0) return `${minutes / 60} h`
  return `${minutes} min`
}

function hostedEgressRows(summary: Record<string, any>) {
  const rows: string[][] = [["Data leaving device", summary.input_kinds.join(", ")]]
  const bucket = (label: string, value: Record<string, any> | undefined, extra?: string) => {
    if (!value) return
    rows.push([
      label,
      [
        `${value.count} item${value.count === 1 ? "" : "s"}`,
        extra,
        formatApprovalBytes(value.total_bytes),
        `SHA-256 ${value.sha256}`,
      ]
        .filter(Boolean)
        .join(" · "),
    ])
  }
  const sequences = summary.sequences
  bucket("Sequences", sequences, sequences?.lengths?.length ? `lengths ${sequences.lengths.join(", ")}` : undefined)
  bucket("Structures", summary.structures)
  bucket("Alignments", summary.alignments)
  bucket("Ligands", summary.ligands)
  bucket("Asset references", summary.asset_references)
  bucket("Design instructions", summary.instructions)
  if (summary.scalar_parameters.length)
    rows.push([
      "Parameters",
      summary.scalar_parameters.map((item: Record<string, any>) => `${item.name}=${String(item.value)}`).join(" · "),
    ])
  return rows
}

function studyBudget(budget: Record<string, any> | undefined) {
  if (!budget) return "no budget"
  const parts = [
    budget.maxRuns !== undefined ? `${budget.maxRuns} runs` : undefined,
    budget.maxHours !== undefined ? `${budget.maxHours} h of compute` : undefined,
    budget.maxCostUSD !== undefined ? `$${budget.maxCostUSD} of model spend` : undefined,
    budget.target !== undefined ? `stop at ${budget.target}` : undefined,
    budget.runMinutes !== undefined ? `${budget.runMinutes} min per run` : undefined,
  ].filter((value): value is string => Boolean(value))
  return parts.length ? parts.join(" · ") : "no budget"
}

function hostedScientific(metadata: Metadata) {
  const scientific = metadata?.scientific_capability
  return scientific?.provider === "nvidia" &&
    scientific?.endpoint &&
    scientific?.status_endpoint_template &&
    scientific?.status_host &&
    scientific?.api_schema_version &&
    /^[a-f0-9]{64}$/u.test(scientific?.request_sha256 ?? "") &&
    /^[a-f0-9]{64}$/u.test(scientific?.approval_sha256 ?? "") &&
    Number.isSafeInteger(scientific?.payload_bytes) &&
    scientific?.payload_bytes >= 0 &&
    Array.isArray(scientific?.egress_summary?.input_kinds) &&
    scientific?.egress_summary?.input_kinds.length > 0 &&
    Array.isArray(scientific?.egress_summary?.scalar_parameters) &&
    scientific?.terms_url &&
    scientific?.method === "POST" &&
    scientific?.warning
    ? scientific
    : undefined
}

type Labels = {
  deny: string
  allow: string
  allowOnce: string
  session: string
  project: string
  always: string
  grantRead: (path: string) => string
  grantWrite: (path: string) => string
  allowHost: (host: string) => string
  runCode: (language: string) => string
  runShell: string
  required: string
}

/** The words of one request, from the metadata the tool attached to it. */
export function describeRequest(metadata: Metadata, labels: Labels): RequestModel {
  const compute = metadata?.compute
  const study = metadata?.study?.id && metadata?.study?.target ? metadata.study : undefined
  const mutation = metadata?.environment_mutation
  const hosted = hostedScientific(metadata)
  const once: Action = { reply: "once", label: labels.allowOnce }
  const standing = (notes?: Partial<Record<Scope["reply"], string>>): Scope[] => [
    { reply: "session", label: labels.session, note: notes?.session },
    { reply: "project", label: labels.project, note: notes?.project },
    { reply: "always", label: labels.always, note: notes?.always },
  ]

  if (study) {
    const target = study.target ?? {}
    const where =
      target.kind === "modal" ? `Modal${target.gpu ? ` · ${target.gpu} GPU` : ""}` : (target.kind ?? "a remote target")
    const followUp = Number.isFinite(study.followUpMinutes) ? Number(study.followUpMinutes) : undefined
    return {
      kind: "study",
      title: `Approve study: ${study.name ?? "Study"}`,
      subline: [
        where,
        studyBudget(study.budget),
        `${study.concurrency ?? 1} at a time`,
        study.killCriteria ? `kill rule ${study.killCriteria}` : undefined,
      ]
        .filter(Boolean)
        .join(" · "),
      rows: [
        ["Target", where],
        ["Budget", studyBudget(study.budget)],
        ["Concurrency", `${study.concurrency ?? 1} run${study.concurrency === 1 ? "" : "s"} at a time`],
        ...(study.killCriteria ? [["Kill rule", String(study.killCriteria)]] : []),
        ...(followUp !== undefined
          ? [["Follow-up jobs", `up to ${minutesLabel(followUp)} of Modal time after the runs`]]
          : []),
      ],
      warning:
        target.kind === "modal"
          ? "Runs in your Modal account, outside OpenScience's local sandbox, and may incur Modal charges until each run exits, is killed by the rule above, or reaches its timeout."
          : "Runs on the saved remote target, outside OpenScience's local sandbox.",
      note: `One approval covers every run this study dispatches inside its budget${
        followUp !== undefined
          ? `, and ${minutesLabel(followUp)} of follow-up Modal jobs such as the final refit and external baselines`
          : ""
      }; each dispatch is still recorded with its plan digest. Approving only this request makes the first run ask again.`,
      primary: { reply: "session", label: "Approve study" },
      secondary: { reply: "once", label: "Only this request" },
      scopes: [{ reply: "project", label: labels.project, note: "Also for later conversations in this project" }],
    }
  }

  if (hosted) {
    return {
      kind: "hosted-scientific",
      title: `Send ${hostedScientificLabel(String(hosted.id))} request to NVIDIA`,
      subline: `${shortBytes(hosted.payload_bytes)} leaves this device: ${hosted.egress_summary.input_kinds.join(", ")} · ${endpointHost(hosted.endpoint)}`,
      rows: [
        ["Provider", String(hosted.provider).toUpperCase()],
        ["Request host", endpointHost(hosted.endpoint)],
        ["Request endpoint", hosted.endpoint],
        ["Status host", hosted.status_host],
        ["Status endpoint", hosted.status_endpoint_template],
        ["API schema", hosted.api_schema_version],
        ["Method", hosted.method],
        ["Payload exact", formatApprovalBytes(hosted.payload_bytes)],
        ["Request SHA-256", hosted.request_sha256],
        ...hostedEgressRows(hosted.egress_summary),
        ["Terms", hosted.terms_url],
      ],
      warning: hosted.warning,
      note: "This approval is one-time only. It is bound to this exact provider, request endpoint, status endpoint, API schema version, bounded data-egress summary, payload size, request hash, and terms URL. NVIDIA does not disclose a model-weight version here. It does not create standing host or provider access.",
      primary: once,
      scopes: [],
    }
  }

  if (mutation?.plan_digest) {
    const operation =
      mutation.operation === "package_install"
        ? "Install"
        : mutation.operation === "package_remove"
          ? "Remove"
          : "Update"
    const packages: string[] = Array.isArray(mutation.packages) ? mutation.packages.map(String) : []
    const language =
      mutation.language === "r" ? "R" : mutation.language === "python" ? "Python" : String(mutation.language ?? "")
    const what =
      mutation.operation === "package_install"
        ? "packages"
        : mutation.operation === "package_remove"
          ? "packages"
          : "environment"
    return {
      kind: "environment-mutation",
      title: packages.length
        ? `${operation} ${packages.slice(0, 3).join(", ")}${packages.length > 3 ? ` +${packages.length - 3}` : ""} in ${language}`
        : `${operation} ${what} in the ${language} environment`,
      subline: [mutation.environment, mutation.manager, `${language} kernel restarts`].filter(Boolean).join(" · "),
      rows: [
        ["Language", language],
        ["Environment", String(mutation.environment ?? "")],
        ["Manager", String(mutation.manager ?? "")],
        ...(packages.length ? [["Packages", packages.join(", ")]] : []),
      ],
      warning: mutation.warning,
      note: "Every scope applies only to this exact requested change. A successful change restarts this environment and clears its in-memory state; files and execution history remain.",
      primary: once,
      scopes: standing(),
    }
  }

  if (compute?.provider === "modal") {
    const resources = compute.resources ?? {}
    const allowance = compute.allowance?.proposed_minutes
    const coveredBy = /^allowance:(\d+)$/.exec(String(compute.allowance?.covered_by ?? ""))
    const covered = coveredBy
      ? `covered; ${minutesLabel(Number(compute.allowance?.used_minutes ?? 0))} of ${minutesLabel(Number(coveredBy[1]))} used`
      : undefined
    const machine = [
      compute.gpu === "none" ? "CPU" : `${compute.gpu} GPU`,
      resources.cpus ? `${resources.cpus} CPU` : undefined,
      resources.memory_gb ? `${resources.memory_gb} GB` : undefined,
    ].filter(Boolean)
    const plus = allowance ? ` · +${minutesLabel(allowance)}` : ""
    return {
      kind: "remote-compute",
      title: `Run on Modal: ${compute.name ?? compute.purpose ?? "job"}`,
      subline: [
        ...machine,
        `${compute.timeout_minutes} min`,
        compute.network === "none" ? "no network" : "network on",
        compute.upload_bytes ? `${shortBytes(compute.upload_bytes)} uploaded` : undefined,
      ]
        .filter(Boolean)
        .join(" · "),
      rows: [
        ["Purpose", String(compute.purpose ?? "")],
        ["Machine", [...machine, compute.image].filter(Boolean).join(" · ")],
        ["Timeout", `${compute.timeout_minutes} min`],
        ["Network", compute.network === "none" ? "Blocked" : "Unrestricted"],
        ...(compute.command ? [["Command", String(compute.command)]] : []),
        ...(Array.isArray(compute.uploads) && compute.uploads.length
          ? [
              [
                "Uploads",
                `${compute.uploads.length} file${compute.uploads.length === 1 ? "" : "s"} · ${shortBytes(compute.upload_bytes ?? 0)}`,
              ],
            ]
          : []),
        ...(covered !== undefined ? [["Allowance", covered]] : []),
      ],
      warning:
        "Runs in your Modal account, outside OpenScience's local sandbox. It may incur Modal charges until the job exits, is cancelled, or reaches its timeout.",
      note: allowance
        ? `Allow once approves this exact plan. A conversation or project approval also allows further Modal jobs there, up to ${minutesLabel(allowance)} of job time in total (each job's timeout counts), then asks again.`
        : "Every scope is bound to this exact plan, including its command, machine, image, network, and input file hashes.",
      primary: once,
      scopes: [
        { reply: "session", label: `${labels.session}${plus}` },
        { reply: "project", label: `${labels.project}${plus}` },
        { reply: "always", label: `${labels.always}${plus}` },
      ],
      scopeNote: allowance ? `Each scope also allows up to ${minutesLabel(allowance)} of Modal jobs there` : undefined,
    }
  }

  if (compute?.provider === "ssh") {
    return {
      kind: "ssh",
      title: `Run on ${compute.label ?? compute.host ?? "a saved SSH host"}: ${compute.name ?? compute.purpose ?? "job"}`,
      subline: [
        compute.host,
        compute.scheduler === "none" ? "direct SSH" : String(compute.scheduler ?? "").toUpperCase(),
        compute.upload_bytes ? `${shortBytes(compute.upload_bytes)} uploaded` : undefined,
      ]
        .filter(Boolean)
        .join(" · "),
      rows: [
        ["Purpose", String(compute.purpose ?? "")],
        ["Host", `${compute.label} · ${compute.host}`],
        ["Scheduler", compute.scheduler === "none" ? "Direct SSH" : String(compute.scheduler).toUpperCase()],
        ["Host key", String(compute.fingerprint ?? "")],
        ...(compute.command ? [["Command", String(compute.command)]] : []),
      ],
      warning: compute.warning,
      note: "Every scope is bound to this exact plan, including its command, host, and input file hashes.",
      primary: once,
      scopes: standing(),
    }
  }

  const filesystem = metadata?.filesystem
  if (filesystem?.path) {
    const write = filesystem.access === "write"
    return {
      kind: "folder",
      title: write ? labels.grantWrite(filesystem.path) : labels.grantRead(filesystem.path),
      rows: [],
      note: "Folder access stays within this project, whichever scope you choose.",
      primary: once,
      scopes: standing().filter((scope) => scope.reply !== "always"),
    }
  }
  const network = metadata?.network
  if (network?.host) {
    return {
      kind: "network",
      title: labels.allowHost(network.host),
      subline: typeof metadata?.url === "string" && metadata.url.trim() ? metadata.url.trim() : undefined,
      rows: [],
      note: "Everywhere adds the host to the Network allow-list in settings.",
      primary: once,
      scopes: standing(),
    }
  }
  const url = metadata?.url
  if (typeof url === "string" && url.trim()) {
    return { kind: "fetch", title: url.trim(), rows: [], primary: once, scopes: standing() }
  }
  const query = metadata?.query
  if (typeof query === "string" && query.trim()) {
    return { kind: "search", title: `“${query.trim()}”`, rows: [], primary: once, scopes: standing() }
  }
  // Running code is the request a person meets most, and the only one whose
  // subject is long: the card names what runs and the tool row above, held
  // open while the card is up, shows the source itself.
  const kernel = metadata?.kernel
  if (kernel?.language === "python" || kernel?.language === "r") {
    const lines = Number.isSafeInteger(kernel.lines) && kernel.lines > 0 ? kernel.lines : undefined
    return {
      kind: "code",
      title: labels.runCode(kernel.language === "r" ? "R" : "Python"),
      subline: [kernel.title, lines ? `${lines} ${lines === 1 ? "line" : "lines"}` : undefined]
        .filter(Boolean)
        .join(" · "),
      rows: [],
      primary: once,
      scopes: standing(),
    }
  }
  const command = metadata?.shell?.command
  if (typeof command === "string" && command.trim()) {
    const [first = "", ...rest] = command.trim().split("\n")
    return {
      kind: "code",
      title: labels.runShell,
      subline: rest.length ? `${first} … +${rest.length} ${rest.length === 1 ? "line" : "lines"}` : first,
      rows: [],
      primary: once,
      scopes: standing(),
    }
  }
  return { kind: "generic", title: labels.required, rows: [], primary: once, scopes: standing() }
}

function el<K extends keyof HTMLElementTagNameMap | keyof SVGElementTagNameMap>(
  tag: K,
  attrs: Record<string, string | boolean | undefined> = {},
  text?: string,
) {
  const node =
    tag === "svg"
      ? document.createElementNS("http://www.w3.org/2000/svg", "svg")
      : document.createElement(tag as keyof HTMLElementTagNameMap)
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined || value === false) continue
    if (value === true) node.setAttribute(key, "")
    else node.setAttribute(key, value)
  }
  if (text !== undefined) node.textContent = text
  return node
}

function append(parent: Element, ...children: Array<Node | string | undefined>) {
  for (const child of children) {
    if (child === undefined) continue
    parent.appendChild(child instanceof Node ? child : document.createTextNode(child))
  }
  return parent
}

function shieldIcon() {
  const definition = iconDefinitions.shield
  const root = el("div", {
    "data-component": "icon",
    "data-icon": "shield",
    "data-icon-source": definition.source,
    "data-size": "small",
    "data-icon-variant": definition.variant,
    "aria-hidden": "true",
  })
  const svg = el("svg", {
    "data-slot": "icon-svg",
    fill: "none",
    viewBox: "0 0 24 24",
    preserveAspectRatio: "xMidYMid meet",
    "aria-hidden": "true",
  })
  svg.innerHTML = definition.body
  root.appendChild(svg)
  return root
}

function button(
  label: string,
  variant: "primary" | "secondary" | "ghost",
  onClick: () => void,
  opts: { ref?: (element: HTMLButtonElement) => void; expanded?: boolean; title?: string } = {},
) {
  const node = el("button", {
    type: "button",
    "data-component": "button",
    "data-size": "small",
    "data-variant": variant,
    ...(opts.title ? { title: opts.title } : {}),
  }) as HTMLButtonElement
  if (opts.expanded !== undefined) node.setAttribute("aria-expanded", String(opts.expanded))
  node.textContent = label
  node.addEventListener("click", onClick)
  opts.ref?.(node)
  return node
}

/**
 * The request card. One shape for every approval: the shield, an eyebrow
 * naming the kind, the decision in one line, the facts in one quiet line, the
 * rest behind Details, and Deny · Allow… · Allow once on the right. "Allow…"
 * turns the row into the scopes; Cancel turns it back.
 */
export function PermissionActions(props: { respond: (response: PermissionReply) => void; metadata?: Metadata }) {
  const i18n = useI18n()
  const model = describeRequest(props.metadata, {
    deny: i18n.t("ui.permission.deny"),
    allow: i18n.t("ui.permission.allow"),
    allowOnce: i18n.t("ui.permission.allowOnce"),
    session: i18n.t("ui.permission.allowSession"),
    project: i18n.t("ui.permission.allowProject"),
    always: i18n.t("ui.permission.allowAlways"),
    grantRead: (path) => i18n.t("ui.permission.grantRead", { path }),
    grantWrite: (path) => i18n.t("ui.permission.grantWrite", { path }),
    allowHost: (host) => i18n.t("ui.permission.allowHost", { host }),
    runCode: (language) => i18n.t("ui.permission.runCode", { language }),
    runShell: i18n.t("ui.permission.runShell"),
    required: i18n.t("ui.permission.required"),
  })
  let scopes = false
  let scopeTrigger: HTMLButtonElement | undefined
  let scopeBack: HTMLButtonElement | undefined
  const root = el("div") as HTMLDivElement

  const setExpanded = (value: boolean, focus: "back" | "trigger" | undefined) => {
    scopes = value
    render()
    if (focus === "back") queueMicrotask(() => scopeBack?.focus())
    if (focus === "trigger") queueMicrotask(() => scopeTrigger?.focus())
  }

  const renderActions = () => {
    const actions = el("div", {
      "data-slot": "request-actions",
      role: "group",
      "aria-label": scopes ? i18n.t("ui.permission.chooseScope") : i18n.t("ui.permission.actions"),
    })
    if (scopes) {
      append(
        actions,
        button(i18n.t("ui.common.cancel"), "ghost", () => setExpanded(false, "trigger"), {
          ref: (element) => (scopeBack = element),
        }),
        ...model.scopes.map((scope) =>
          button(scope.label, "secondary", () => props.respond(scope.reply), { title: scope.note }),
        ),
      )
      return actions
    }
    append(
      actions,
      button(i18n.t("ui.permission.deny"), "ghost", () => props.respond("reject")),
    )
    if (model.secondary) {
      append(
        actions,
        button(model.secondary.label, "ghost", () => props.respond(model.secondary!.reply)),
      )
    }
    if (model.scopes.length) {
      append(
        actions,
        button(i18n.t("ui.permission.allow"), "secondary", () => setExpanded(true, "back"), {
          ref: (element) => (scopeTrigger = element),
          expanded: scopes,
        }),
      )
    }
    append(
      actions,
      button(model.primary.label, "primary", () => props.respond(model.primary.reply)),
    )
    return actions
  }

  const render = () => {
    for (const attr of [...root.attributes]) root.removeAttribute(attr.name)
    root.setAttribute("data-component", "request-card")
    root.setAttribute("data-kind", model.kind)
    root.setAttribute("data-expanded", String(scopes))
    root.setAttribute("aria-label", `${i18n.t("ui.permission.required")}: ${model.title}`)

    const head = el("div", { "data-slot": "request-head" })
    const copy = el("div", { "data-slot": "request-copy" })
    append(
      copy,
      el(
        "span",
        { "data-slot": "request-eyebrow" },
        scopes
          ? `${i18n.t("ui.permission.chooseScope")}${model.scopeNote ? ` · ${model.scopeNote}` : ""}`
          : i18n.t("ui.permission.required"),
      ),
    )
    append(copy, el("strong", { "data-slot": "request-title", title: model.title }, model.title))
    if (model.subline) append(copy, el("span", { "data-slot": "request-subline", title: model.subline }, model.subline))
    append(head, shieldIcon(), copy)

    const hasDetails = model.rows.length > 0 || !!model.warning || !!model.note
    const details = hasDetails ? el("details", { "data-slot": "request-details" }) : undefined
    if (details) {
      append(details, el("summary", {}, "Details"))
      if (model.rows.length) {
        const grid = el("div", { "data-slot": "request-rows" })
        for (const [label, value] of model.rows) append(grid, el("span", {}, label), el("strong", {}, String(value)))
        append(details, grid)
      }
      if (model.warning) append(details, el("p", { "data-slot": "request-warning" }, model.warning))
      if (model.note) append(details, el("p", { "data-slot": "request-note" }, model.note))
    }
    root.replaceChildren(head, ...(details ? [details] : []), renderActions())
  }

  render()
  return root
}
