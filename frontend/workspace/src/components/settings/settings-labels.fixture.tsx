import { FormField } from "./_shared"

/** A connector form as Connectors mounts it: the host value opts into the
 * monospace utility, the display name beside it stays in the dialog's own
 * type. Both are the real `FormField`, so the test sees the classes the panel
 * actually renders. */
export const ConnectorFields = () => (
  <>
    <FormField label="Host" value="lab.example.org" onInput={() => {}} mono />
    <FormField label="Name" value="Lab" onInput={() => {}} />
  </>
)
