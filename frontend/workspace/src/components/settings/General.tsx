import { AppearanceSections } from "../settings-general"
import { PanelBody, PanelHeader, PanelScroll } from "./_shared"
import { Subagents } from "./subagents"
import "./preference-panels.css"

/**
 * App preferences: appearance, notifications, sounds. Account and billing
 * live under Ace; trace sharing sits with the other consent controls under
 * Permissions.
 */
export default function General() {
  return (
    <PanelScroll>
      <div class="settings-preferences-panel settings-preferences-panel--general">
        <PanelHeader title="General" description="How OpenScience looks and behaves on this device." />
        <PanelBody>
          <AppearanceSections />
          <Subagents />
        </PanelBody>
      </div>
    </PanelScroll>
  )
}
