const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("electronAPI", {
  importServiceAccountKey: () => ipcRenderer.invoke("dialog:importServiceAccountKey"),
  getServiceAccountStatus: () => ipcRenderer.invoke("sheets:getServiceAccountStatus"),
  loadPeopleFromSheets: (payload) => ipcRenderer.invoke("sheets:loadPeople", payload),
  firebaseGetStatus: () => ipcRenderer.invoke("firebase:getStatus"),
  firebaseSaveJoinConfig: (payload) => ipcRenderer.invoke("firebase:saveJoinConfig", payload),
  firebaseClearConfig: () => ipcRenderer.invoke("firebase:clearConfig"),
  firebaseSignIn: () => ipcRenderer.invoke("firebase:signIn"),
  firebaseSignOut: () => ipcRenderer.invoke("firebase:signOut"),
  firebaseLoadPeople: () => ipcRenderer.invoke("firebase:loadPeople"),
  firebaseFetchProfilePhoto: (payload) => ipcRenderer.invoke("firebase:fetchProfilePhoto", payload),
  networkShareGetStatus: () => ipcRenderer.invoke("networkShare:getStatus"),
  networkShareStart: (payload) => ipcRenderer.invoke("networkShare:start", payload),
  networkShareStop: () => ipcRenderer.invoke("networkShare:stop"),
  updaterGetStatus: () => ipcRenderer.invoke("updater:getStatus"),
  updaterCheckNow: () => ipcRenderer.invoke("updater:checkNow"),
  updaterOpenUpdatePage: () => ipcRenderer.invoke("updater:openUpdatePage"),
  appQuit: () => ipcRenderer.invoke("app:quit"),
  saveBinaryFile: (payload) => ipcRenderer.invoke("dialog:saveBinaryFile", payload),
  canvaGetStatus: () => ipcRenderer.invoke("canva:getStatus"),
  canvaSaveCredentials: (payload) => ipcRenderer.invoke("canva:saveCredentials", payload),
  canvaLogin: () => ipcRenderer.invoke("canva:login"),
  canvaLogout: () => ipcRenderer.invoke("canva:logout"),
  canvaSendBadgeAutofill: (payload) => ipcRenderer.invoke("canva:sendBadgeAutofill", payload),
  canvaSendPdf: (payload) => ipcRenderer.invoke("canva:sendPdf", payload)
});
