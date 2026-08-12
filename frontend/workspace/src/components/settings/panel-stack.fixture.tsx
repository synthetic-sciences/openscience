import { createSignal } from "solid-js"
import { SettingsPanelStack } from "./panel-stack"

export function createPanelStackFixture(onReady: (select: (id: "models" | "network") => void) => void) {
  const [active, setActive] = createSignal<"models" | "network">("models")
  const mounts = { models: 0, network: 0 }
  const Models = () => {
    mounts.models += 1
    return <input aria-label="Model filter" value="remember me" />
  }
  const Network = () => {
    mounts.network += 1
    return <div>Network settings</div>
  }
  onReady(setActive)

  return {
    mounts,
    view: () => (
      <SettingsPanelStack
        active={active}
        panels={() => [
          { id: "models", component: Models },
          { id: "network", component: Network },
        ]}
      />
    ),
  }
}
