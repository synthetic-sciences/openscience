import { createEffect, createMemo, Show, type ParentProps } from "solid-js"
import { useNavigate, useParams } from "@solidjs/router"
import { SDKProvider, useSDK } from "@/context/sdk"
import { SyncProvider, useSync } from "@/context/sync"
import { LocalProvider } from "@/context/local"

import { DataProvider } from "@synsci/ui/context"
import { iife } from "@synsci/util/iife"
import type { QuestionAnswer } from "@synsci/sdk/v2"
import { decode64 } from "@/utils/base64"
import { showToast } from "@synsci/ui/toast"
import { useLanguage } from "@/context/language"
import { centerTabs } from "@/thesis/store/centerTabs"

export default function Layout(props: ParentProps) {
  const params = useParams()
  const navigate = useNavigate()
  const language = useLanguage()
  const directory = createMemo(() => {
    return decode64(params.dir) ?? ""
  })

  createEffect(() => {
    if (!params.dir) return
    if (directory()) return
    showToast({
      variant: "error",
      title: language.t("common.requestFailed"),
      description: "Invalid directory in URL.",
    })
    navigate("/")
  })
  return (
    <Show when={directory()}>
      <SDKProvider directory={directory()}>
        <SyncProvider>
          {iife(() => {
            const sync = useSync()
            const sdk = useSDK()
            const respond = (input: {
              sessionID: string
              permissionID: string
              response: "once" | "always" | "reject"
            }) => sdk.client.permission.respond(input)

            const replyToQuestion = (input: { requestID: string; answers: QuestionAnswer[] }) =>
              sdk.client.question.reply(input)

            const rejectQuestion = (input: { requestID: string }) => sdk.client.question.reject(input)

            const navigateToSession = (sessionID: string) => {
              navigate(`/${params.dir}/session/${sessionID}`)
            }

            // Open a file referenced in the chat (tool cards, diffs) as a
            // center-tab document — same surface the Files tab / explorer use.
            // Tool filePaths are usually absolute; FileView wants a path relative
            // to the re-rooted directory, so strip the project prefix here.
            const openFile = (path: string) => {
              const dir = directory()
              const rel = dir && path.startsWith(dir + "/") ? path.slice(dir.length + 1) : path
              centerTabs.openFile(dir, rel)
            }

            return (
              <DataProvider
                data={sync.data}
                directory={directory()}
                onPermissionRespond={respond}
                onQuestionReply={replyToQuestion}
                onQuestionReject={rejectQuestion}
                onNavigateToSession={navigateToSession}
                onOpenFile={openFile}
              >
                <LocalProvider>{props.children}</LocalProvider>
              </DataProvider>
            )
          })}
        </SyncProvider>
      </SDKProvider>
    </Show>
  )
}
