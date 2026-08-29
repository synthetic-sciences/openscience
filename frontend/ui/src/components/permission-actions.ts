import { iconDefinitions } from "./iconoir-registry"
import { useI18n } from "../context/i18n"

export type PermissionReply = "once" | "session" | "project" | "always" | "reject"

type Metadata = Record<string, any> | undefined

function modalMachine(plan: Record<string, any>) {
  const resources = plan.resources ?? {}
  return [
    plan.gpu === "none" ? "CPU" : `${plan.gpu} GPU`,
    resources.cpus ? `${resources.cpus} CPU` : undefined,
    resources.memory_gb ? `${resources.memory_gb} GB memory` : undefined,
    plan.image,
  ]
    .filter((value): value is string => Boolean(value))
    .join(" · ")
}

function computeDetails(plan: Record<string, any>) {
  if (plan.provider === "modal") {
    return [
      ["Machine", modalMachine(plan)],
      ["Timeout", `${plan.timeout_minutes} min`],
      ["Network", plan.network === "none" ? "Blocked" : "Unrestricted"],
    ]
  }
  return [
    ["Host", `${plan.label} · ${plan.host}`],
    ["Scheduler", plan.scheduler === "none" ? "Direct SSH" : String(plan.scheduler).toUpperCase()],
    ["Host key", plan.fingerprint],
  ]
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

function formatApprovalBytes(value: number) {
  const bytes = Math.max(0, Math.trunc(value))
  const exact = new Intl.NumberFormat("en-US").format(bytes)
  if (!Number.isFinite(value) || bytes < 1024) return `${exact} bytes`
  if (bytes < 1024 * 1024) return `${Number((bytes / 1024).toFixed(1))} KB (${exact} bytes)`
  return `${Number((bytes / (1024 * 1024)).toFixed(1))} MB (${exact} bytes)`
}

function endpointHost(value: string) {
  try {
    return new URL(value).host
  } catch {
    return value
  }
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

function setAttrs(node: Element, attrs: Record<string, string | boolean | undefined>) {
  for (const attr of [...node.attributes]) node.removeAttribute(attr.name)
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined || value === false) continue
    if (value === true) node.setAttribute(key, "")
    else node.setAttribute(key, value)
  }
  return node
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
  opts: { ref?: (element: HTMLButtonElement) => void; expanded?: boolean } = {},
) {
  const node = el("button", {
    type: "button",
    "data-component": "button",
    "data-size": "small",
    "data-variant": variant,
  }) as HTMLButtonElement
  if (opts.expanded !== undefined) node.setAttribute("aria-expanded", String(opts.expanded))
  node.textContent = label
  node.addEventListener("click", onClick)
  opts.ref?.(node)
  return node
}

export function PermissionActions(props: { respond: (response: PermissionReply) => void; metadata?: Metadata }) {
  const i18n = useI18n()
  let scopes = false
  let scopeTrigger: HTMLButtonElement | undefined
  let scopeBack: HTMLButtonElement | undefined
  const compute = () => props.metadata?.compute
  const mutation = () => props.metadata?.environment_mutation
  const scientific = () => props.metadata?.scientific_capability
  const hostedScientific = () =>
    scientific()?.provider === "nvidia" &&
    scientific()?.endpoint &&
    scientific()?.status_endpoint_template &&
    scientific()?.status_host &&
    scientific()?.api_schema_version &&
    /^[a-f0-9]{64}$/u.test(scientific()?.request_sha256 ?? "") &&
    /^[a-f0-9]{64}$/u.test(scientific()?.approval_sha256 ?? "") &&
    Number.isSafeInteger(scientific()?.payload_bytes) &&
    scientific()?.payload_bytes >= 0 &&
    Array.isArray(scientific()?.egress_summary?.input_kinds) &&
    scientific()?.egress_summary?.input_kinds.length > 0 &&
    Array.isArray(scientific()?.egress_summary?.scalar_parameters) &&
    scientific()?.terms_url &&
    scientific()?.method === "POST" &&
    scientific()?.warning
      ? scientific()
      : undefined
  const boundary = () => compute() ?? mutation()
  const mutationOperation = () => {
    const value = mutation()?.operation
    if (value === "package_install") return "Install packages"
    if (value === "package_remove") return "Remove packages"
    return "Update environment"
  }
  const summary = () => {
    const filesystem = props.metadata?.filesystem
    if (filesystem?.path) {
      const key = filesystem.access === "write" ? "ui.permission.grantWrite" : "ui.permission.grantRead"
      return i18n.t(key, { path: filesystem.path })
    }
    const network = props.metadata?.network
    if (network?.host) return i18n.t("ui.permission.allowHost", { host: network.host })
    const query = props.metadata?.query
    if (typeof query === "string" && query.trim()) return `“${query.trim()}”`
    return undefined
  }
  const root = el("div") as HTMLDivElement

  const setExpanded = (value: boolean, focus: "back" | "trigger" | undefined) => {
    scopes = value
    render()
    if (focus === "back") queueMicrotask(() => scopeBack?.focus())
    if (focus === "trigger") queueMicrotask(() => scopeTrigger?.focus())
  }

  const renderActions = (special: boolean) => {
    const actions = el("div", {
      "data-slot": "permission-actions",
      role: "group",
      "aria-label": mutation()
        ? "Environment change approval scope"
        : hostedScientific()
          ? "Hosted scientific approval scope"
          : special
            ? "Remote compute approval scope"
            : i18n.t("ui.permission.actions"),
    })
    if (scopes && !hostedScientific()) {
      append(
        actions,
        button(i18n.t("ui.common.cancel"), "ghost", () => setExpanded(false, "trigger"), {
          ref: (element) => (scopeBack = element),
        }),
        button(i18n.t("ui.permission.allowSession"), "secondary", () => props.respond("session")),
        button(i18n.t("ui.permission.allowProject"), "secondary", () => props.respond("project")),
        button(special ? i18n.t("ui.permission.scopeGlobal") : i18n.t("ui.permission.allowAlways"), "secondary", () =>
          props.respond("always"),
        ),
      )
      return actions
    }
    append(
      actions,
      button(i18n.t("ui.permission.deny"), "ghost", () => props.respond("reject")),
    )
    if (!hostedScientific() && special) {
      append(
        actions,
        button(i18n.t("ui.permission.allow"), "secondary", () => setExpanded(true, "back"), {
          ref: (element) => (scopeTrigger = element),
          expanded: scopes,
        }),
      )
    } else if (!special) {
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
      button(
        hostedScientific() || !special ? i18n.t("ui.permission.allowOnce") : i18n.t("ui.permission.scopeOnce"),
        "primary",
        () => props.respond("once"),
      ),
    )
    return actions
  }

  const renderFallback = () => {
    setAttrs(root, {
      "data-component": "permission-prompt",
      "data-expanded": String(scopes),
      "aria-label": i18n.t("ui.permission.required"),
    })
    const context = el("div", { "data-slot": "permission-context" })
    const copy = el("div", { "data-slot": "permission-copy" })
    append(
      copy,
      el(
        "span",
        { "data-slot": "permission-origin" },
        scopes ? i18n.t("ui.permission.chooseScope") : i18n.t("ui.permission.required"),
      ),
    )
    const text = summary()
    if (text) append(copy, el("span", { "data-slot": "permission-summary", title: text }, text))
    append(context, shieldIcon(), copy)
    root.replaceChildren(context, renderActions(false))
  }

  const renderSpecial = () => {
    const special =
      hostedScientific() ||
      ((compute()?.provider === "modal" || compute()?.provider === "ssh") && compute()) ||
      (mutation()?.plan_digest && mutation())
    const kind = mutation() ? "environment-mutation" : hostedScientific() ? "hosted-scientific" : "remote-compute"
    setAttrs(root, {
      "data-component": "permission-prompt",
      "data-kind": kind,
      "data-expanded": String(scopes),
    })
    const origin = el("span", { "data-slot": "permission-origin" }, "OpenScience approval")
    const summaryNode = el("div", { "data-slot": "permission-summary", "data-kind": kind })
    const title = mutation()
      ? `Change ${String(mutation().language).toUpperCase()} environment`
      : hostedScientific()
        ? "Send a hosted scientific request"
        : boundary().provider === "modal"
          ? "Run outside the local sandbox"
          : "Run on a saved SSH host"
    const purpose = mutation()
      ? mutationOperation()
      : hostedScientific()
        ? `${hostedScientificLabel(String(hostedScientific().id))} via NVIDIA`
        : boundary().purpose
    append(summaryNode, el("strong", { "data-slot": "permission-compute-title" }, title))
    append(summaryNode, el("span", { "data-slot": "permission-compute-purpose" }, purpose))
    const details = el("div", {
      "data-slot": "permission-compute-details",
      "aria-label": mutation()
        ? "Environment change details"
        : hostedScientific()
          ? "Hosted scientific request details"
          : "Remote job details",
    })
    const rows = mutation()
      ? [
          ["Language", String(mutation().language).toUpperCase()],
          ["Environment", mutation().environment],
          ["Manager", mutation().manager],
        ]
      : hostedScientific()
        ? [
            ["Provider", hostedScientific().provider.toUpperCase()],
            ["Request host", endpointHost(hostedScientific().endpoint)],
            ["Request endpoint", hostedScientific().endpoint],
            ["Status host", hostedScientific().status_host],
            ["Status endpoint", hostedScientific().status_endpoint_template],
            ["API schema", hostedScientific().api_schema_version],
            ["Method", hostedScientific().method],
            ["Payload exact", formatApprovalBytes(hostedScientific().payload_bytes)],
            ["Request SHA-256", hostedScientific().request_sha256],
            ...hostedEgressRows(hostedScientific().egress_summary),
            ["Terms", hostedScientific().terms_url],
          ]
        : computeDetails(boundary())
    for (const [label, value] of rows) {
      append(details, el("span", {}, label), el("strong", {}, String(value)))
    }
    append(summaryNode, details)
    append(
      summaryNode,
      el(
        "span",
        { "data-slot": "permission-compute-warning" },
        mutation()
          ? mutation().warning
          : hostedScientific()
            ? hostedScientific().warning
            : boundary().provider === "modal"
              ? "Runs in your Modal account, outside OpenScience's local sandbox. It may incur Modal charges until the job exits, is cancelled, or reaches its timeout."
              : boundary().warning,
      ),
      el(
        "span",
        { "data-slot": "permission-compute-scope" },
        mutation()
          ? "Every scope applies only to this exact requested change. A successful change restarts this environment and clears its in-memory state; files and execution history remain."
          : hostedScientific()
            ? "This approval is one-time only. It is bound to this exact provider, request endpoint, status endpoint, API schema version, bounded data-egress summary, payload size, request hash, and terms URL. NVIDIA does not disclose a model-weight version here. It does not create standing host or provider access."
            : "Every scope is bound to this exact plan, including its command, machine, image, network, and input file hashes.",
      ),
    )
    root.replaceChildren(origin, summaryNode, renderActions(Boolean(special)))
  }

  const render = () => {
    const special =
      ((compute()?.provider === "modal" || compute()?.provider === "ssh") && compute()) ||
      (mutation()?.plan_digest && mutation()) ||
      hostedScientific()
    if (special) renderSpecial()
    else renderFallback()
  }

  render()
  return root
}
