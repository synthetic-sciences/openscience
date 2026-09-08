import { Show, createEffect, createSignal, onCleanup, type Component } from "solid-js"
import { showToast } from "@synsci/ui/toast"

export const LOGIN_APPROVAL_EVENT = "openscience:login-approval"

/**
 * The sign-in page the server tried to open, offered as a link while a
 * browser sign-in is pending. On a host that cannot launch a browser (SSH, a
 * container, a desktop without a default handler) this is the only way to
 * finish signing in before the server gives up.
 */
export const LoginApproval: Component<{ active: boolean; openLink: (url: string) => void }> = (props) => {
  const [url, setUrl] = createSignal<string>()

  const onApproval = (event: Event) => {
    const detail = (event as CustomEvent<unknown>).detail
    if (typeof detail === "string" && detail) setUrl(detail)
  }
  window.addEventListener(LOGIN_APPROVAL_EVENT, onApproval)
  onCleanup(() => window.removeEventListener(LOGIN_APPROVAL_EVENT, onApproval))

  // A link from an earlier attempt is single-use; forget it once that attempt ends.
  createEffect(() => {
    if (!props.active) setUrl(undefined)
  })

  const copy = (value: string) =>
    navigator.clipboard?.writeText(value).then(
      () => showToast({ title: "Sign-in link copied" }),
      () => showToast({ title: "Couldn't copy the sign-in link", description: value }),
    )

  return (
    <Show when={props.active && url()}>
      {(value) => (
        <p class="text-12-regular text-text-weak" data-login-approval>
          Browser didn't open?{" "}
          <button type="button" class="settings-inline-link" onClick={() => props.openLink(value())}>
            Open the sign-in page
          </button>
          {" · "}
          <button type="button" class="settings-inline-link" onClick={() => void copy(value())}>
            Copy link
          </button>
        </p>
      )}
    </Show>
  )
}
