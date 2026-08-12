import { RightPane } from "@/atlas/RightPane"
import { SessionRenderProviders } from "@/pages/session-shell"

/** Lazy project-route entry so the home screen does not pay for file, terminal,
 * compute, and scientific renderers while the inspector still owns a lifetime
 * above individual session routes. */
export default function ProjectRightPane(props: { project: string; session: string }) {
  return (
    <SessionRenderProviders>
      <RightPane project={props.project} session={props.session} />
    </SessionRenderProviders>
  )
}
