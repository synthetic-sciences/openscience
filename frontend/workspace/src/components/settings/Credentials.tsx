import { type Component } from "solid-js"
import { CredentialServices } from "./CredentialServices"

export const Credentials: Component = () => (
  <div class="flex h-full flex-col overflow-y-auto no-scrollbar">
    <header class="settings-page-header">
      <h2>Credentials</h2>
      <p>Bring the rest of your research stack along. Add a service once, and it is ready when your tools need it.</p>
    </header>
    <div class="settings-page-body">
      <CredentialServices
        category="integration"
        title="Integrations"
        description="A quiet home for GitHub, OpenAlex, Hugging Face, Weights & Biases, and everything in between."
        custom
      />
    </div>
  </div>
)

export default Credentials
