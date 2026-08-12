import { type Component } from "solid-js"
import { CredentialServices } from "./CredentialServices"
import { PanelBody, PanelHeader, PanelScroll } from "./_shared"

export const Credentials: Component = () => (
  <PanelScroll>
    <PanelHeader
      title="Credentials"
      description="Add service credentials once and make them available to the tools that need them."
    />
    <PanelBody>
      <CredentialServices
        category="integration"
        title="Integrations"
        description="GitHub, OpenAlex, Hugging Face, Weights & Biases, and other research services."
        custom
      />
    </PanelBody>
  </PanelScroll>
)

export default Credentials
