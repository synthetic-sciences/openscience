/** @jsxImportSource solid-js */
import { splitProps, type ComponentProps } from "solid-js"
import { iconDefinitions, type IconName } from "./iconoir-registry"

export interface IconProps extends ComponentProps<"svg"> {
  name: IconName
  size?: "small" | "normal" | "medium" | "large"
}

export function Icon(props: IconProps) {
  const [local, others] = splitProps(props, ["name", "size", "class", "classList"])
  const definition = () => iconDefinitions[local.name]

  return (
    <div
      data-component="icon"
      data-icon={local.name}
      data-icon-source={definition().source}
      data-size={local.size || "normal"}
      data-icon-variant={definition().variant}
      aria-hidden="true"
    >
      <svg
        data-slot="icon-svg"
        classList={{
          ...(local.classList || {}),
          [local.class ?? ""]: !!local.class,
        }}
        fill="none"
        viewBox="0 0 24 24"
        preserveAspectRatio="xMidYMid meet"
        innerHTML={definition().body}
        {...others}
        aria-hidden="true"
      />
    </div>
  )
}
