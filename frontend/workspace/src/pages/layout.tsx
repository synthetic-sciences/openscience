import { type ParentProps } from "solid-js"
import { SetupGate } from "@/thesis/SetupGate"

/**
 * Outer Router layout — passthrough.
 *
 * The original openscience Layout added its own top bar + left rail of icons
 * (folder/+/settings/external). Now that the home page (Conductor grid)
 * and the in-session view both render their own headers, the outer
 * chrome was just doubling up. This file used to be 2871 lines; the
 * project sidebar + workspace tab bar logic now lives in src/thesis/*.
 *
 * Returning `props.children` keeps the routing tree intact while letting
 * each page own its own visual chrome. `SetupGate` is a headless first-run
 * gate mounted once here so it spans every screen.
 */
export default function Layout(props: ParentProps) {
  return (
    <>
      {props.children}
      <SetupGate />
    </>
  )
}
