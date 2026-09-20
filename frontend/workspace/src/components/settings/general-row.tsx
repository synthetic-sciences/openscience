import type { Component, JSX } from "solid-js"

interface SettingsRowProps {
  title: string
  description: string | JSX.Element
  children: JSX.Element
}

/** The General panel's row: the title, one muted line beneath it, and one
 *  control at the right. */
export const SettingsRow: Component<SettingsRowProps> = (props) => {
  return (
    <div class="settings-row justify-between">
      <div class="flex min-w-0 flex-1 basis-[220px] flex-col gap-0.5">
        <span class="text-14-medium text-text-strong">{props.title}</span>
        <span class="text-12-regular text-text-weak">{props.description}</span>
      </div>
      <div class="ml-auto max-w-full flex-shrink-0">{props.children}</div>
    </div>
  )
}
