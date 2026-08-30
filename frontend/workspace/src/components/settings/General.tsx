import { AppearanceSections } from "../settings-general"
import { PanelBody, PanelHeader, PanelScroll } from "./_shared"
import "./preference-panels.css"

export default function General() {
  return (
    <PanelScroll>
      <div class="settings-preferences-panel settings-preferences-panel--general">
        <PanelHeader title="General" description="Appearance, notifications, sound, and app updates." />
        <PanelBody>
          <AppearanceSections />
        </PanelBody>
      </div>
    </PanelScroll>
  )
}
