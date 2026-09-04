import type {
  Message,
  Session,
  Part,
  FileDiff,
  SessionStatus,
  SessionRequestProgress,
  PermissionRequest,
  QuestionRequest,
  QuestionAnswer,
} from "@synsci/sdk/v2"
import { createSimpleContext } from "./helper"
import { PreloadMultiFileDiffResult } from "@pierre/diffs/ssr"

type Data = {
  session: Session[]
  session_status: {
    [sessionID: string]: SessionStatus
  }
  // Live provider request phase per session. Optional: older backends never
  // publish it and the status line falls back to its generic copy.
  session_progress?: {
    [sessionID: string]: SessionRequestProgress
  }
  session_diff: {
    [sessionID: string]: FileDiff[]
  }
  session_diff_preload?: {
    [sessionID: string]: PreloadMultiFileDiffResult<any>[]
  }
  permission?: {
    [sessionID: string]: PermissionRequest[]
  }
  question?: {
    [sessionID: string]: QuestionRequest[]
  }
  message: {
    [sessionID: string]: Message[]
  }
  part: {
    [messageID: string]: Part[]
  }
}

export type PermissionRespondFn = (input: {
  sessionID: string
  permissionID: string
  response: "once" | "session" | "project" | "always" | "reject"
}) => void

export type QuestionReplyFn = (input: { requestID: string; answers: QuestionAnswer[] }) => void

export type QuestionRejectFn = (input: { requestID: string }) => void

export type NavigateToSessionFn = (sessionID: string) => void

/** Explicit save: register a written file as a durable Result. */
export type SaveArtifactFn = (path: string) => Promise<void>

/** Open a durable saved artifact version in the contextual Files surface. */
export type OpenArtifactFn = (id: string) => void

export const { use: useData, provider: DataProvider } = createSimpleContext({
  name: "Data",
  init: (props: {
    data: Data
    directory: string
    onPermissionRespond?: PermissionRespondFn
    onQuestionReply?: QuestionReplyFn
    onQuestionReject?: QuestionRejectFn
    onNavigateToSession?: NavigateToSessionFn
    onOpenFile?: (path: string) => void
    onOpenArtifact?: OpenArtifactFn
    onSaveArtifact?: SaveArtifactFn
  }) => {
    return {
      get store() {
        return props.data
      },
      get directory() {
        return props.directory
      },
      respondToPermission: props.onPermissionRespond,
      replyToQuestion: props.onQuestionReply,
      rejectQuestion: props.onQuestionReject,
      navigateToSession: props.onNavigateToSession,
      openFile: props.onOpenFile,
      openArtifact: props.onOpenArtifact,
      saveArtifact: props.onSaveArtifact,
    }
  },
})
