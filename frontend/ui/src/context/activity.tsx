import { createContext, useContext, type Accessor, type ParentProps } from "solid-js"

export type ActivityMode = "detailed" | "compact"

const Activity = createContext<{
  mode: Accessor<ActivityMode>
  change?: (value: ActivityMode) => void
}>({ mode: (): ActivityMode => "detailed" })

export function ActivityProvider(
  props: ParentProps<{
    value: Accessor<ActivityMode>
    onChange?: (value: ActivityMode) => void
  }>,
) {
  return <Activity.Provider value={{ mode: props.value, change: props.onChange }}>{props.children}</Activity.Provider>
}

export const useActivity = () => useContext(Activity).mode
export const useActivityChange = () => useContext(Activity).change
