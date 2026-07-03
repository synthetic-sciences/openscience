import * as vscode from "vscode"

// This method is called when your extension is deactivated
export function deactivate() {}

const TERMINAL_NAME = "openscience"

export function activate(context: vscode.ExtensionContext) {
  const openNewTerminalDisposable = vscode.commands.registerCommand("openscience.openNewTerminal", async () => {
    await openWorkspace()
  })

  const openTerminalDisposable = vscode.commands.registerCommand("openscience.openTerminal", async () => {
    const existing = vscode.window.terminals.find((t) => t.name === TERMINAL_NAME)
    if (existing) {
      existing.show()
      return
    }
    await openWorkspace()
  })

  const addFilepathDisposable = vscode.commands.registerCommand("openscience.addFilepathToTerminal", async () => {
    const fileRef = getActiveFile()
    if (!fileRef) return
    const terminal = vscode.window.activeTerminal
    if (terminal && terminal.name === TERMINAL_NAME) {
      terminal.sendText(fileRef, false)
      terminal.show()
    }
  })

  context.subscriptions.push(openNewTerminalDisposable, openTerminalDisposable, addFilepathDisposable)

  // Launch the OpenScience CLI in a side terminal. `openscience` opens the
  // workspace in the browser; the terminal is where the CLI runs.
  async function openWorkspace() {
    const terminal = vscode.window.createTerminal({
      name: TERMINAL_NAME,
      iconPath: {
        light: vscode.Uri.file(context.asAbsolutePath("images/button-dark.svg")),
        dark: vscode.Uri.file(context.asAbsolutePath("images/button-light.svg")),
      },
      location: {
        viewColumn: vscode.ViewColumn.Beside,
        preserveFocus: false,
      },
      env: {
        OPENSCIENCE_CALLER: "vscode",
      },
    })
    terminal.show()
    terminal.sendText("openscience")
  }

  function getActiveFile() {
    const activeEditor = vscode.window.activeTextEditor
    if (!activeEditor) return
    const document = activeEditor.document
    const workspaceFolder = vscode.workspace.getWorkspaceFolder(document.uri)
    if (!workspaceFolder) return

    const relativePath = vscode.workspace.asRelativePath(document.uri)
    let ref = `@${relativePath}`

    const selection = activeEditor.selection
    if (!selection.isEmpty) {
      const startLine = selection.start.line + 1
      const endLine = selection.end.line + 1
      ref += startLine === endLine ? `#L${startLine}` : `#L${startLine}-${endLine}`
    }
    return ref
  }
}
