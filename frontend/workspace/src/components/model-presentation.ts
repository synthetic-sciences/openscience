type AdvancedControl = {
  id: string
  label: string
  options: string[]
}

type ModelControlInput = {
  name: string
  variants: string[]
  modes: string[]
  currentEffort?: string
  currentSpeed?: string
  advanced?: AdvancedControl[]
}

const names: Record<string, string> = {
  xhigh: "Extra high",
}

const hiddenComposerEfforts = new Set(["max", "ultra"])

const label = (id: string) => {
  const name = names[id]
  if (name) return name
  const value = id.replaceAll(/[-_]+/g, " ")
  return value.charAt(0).toUpperCase() + value.slice(1)
}

const unique = (values: string[]) => [...new Set(values.filter((value) => value.trim().length > 0))]

const selected = (options: Array<{ id: string; label: string }>, value?: string) =>
  options.find((option) => option.id === value) ??
  (value === "none" || value === "standard"
    ? options.find((option) => option.id === "standard" || option.id === "none")
    : undefined) ??
  options.find((option) => option.id === "standard" || option.id === "none") ??
  options[0]

export function effortOption(id: string) {
  return {
    id,
    label: id === "standard" || id === "none" ? "Standard" : label(id),
  }
}

export function serviceOption(id: string) {
  return {
    id,
    label: label(id),
  }
}

export function modelControl(input: ModelControlInput) {
  const variants = unique(input.variants)
  const efforts = variants
    .filter((id) => !hiddenComposerEfforts.has(id))
    .filter((id) => id !== "none" || !variants.includes("standard"))
    .map(effortOption)
  const services = unique(input.modes).map(serviceOption)
  const currentEffort = hiddenComposerEfforts.has(input.currentEffort ?? "")
    ? (efforts.find((option) => option.id === "xhigh") ??
      efforts.find((option) => option.id === "high") ??
      selected(efforts))
    : selected(efforts, input.currentEffort)
  const currentSpeed = selected(services, input.currentSpeed)
  const effort = currentEffort
    ? {
        label: "Effort",
        value: currentEffort.label,
        current: currentEffort,
        options: efforts,
      }
    : undefined
  const speed =
    services.length > 1 && currentSpeed
      ? {
          label: "Speed",
          value: currentSpeed.label,
          current: currentSpeed,
          options: services,
        }
      : undefined
  const advanced = input.advanced?.filter((control) => control.options.length > 0) ?? []
  const reset = {
    ...(input.currentEffort && currentEffort && input.currentEffort !== currentEffort.id
      ? { effort: currentEffort.id }
      : {}),
    ...(input.currentSpeed && currentSpeed && input.currentSpeed !== currentSpeed.id ? { speed: currentSpeed.id } : {}),
  }

  return {
    rows: ["Model", ...(effort ? ["Effort"] : []), ...(speed ? ["Speed"] : []), "Advanced"],
    trigger: input.name,
    model: { label: "Model", value: input.name },
    effort,
    speed,
    advanced,
    reset,
  }
}
