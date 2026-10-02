const { contextBridge, ipcRenderer } = require("electron")

// The main process checks the sending window and frame. No generic IPC or
// filesystem access is exposed, and remote workspace windows have no preload.
contextBridge.exposeInMainWorld("openscienceDesktop", {
  openWorkspace: (url) => ipcRenderer.invoke("openscience:open-workspace", url),
})
