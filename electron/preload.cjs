const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("electronAPI", {
  pickServiceAccountKey: () => ipcRenderer.invoke("dialog:pickServiceAccountKey"),
  loadPeopleFromSheets: (payload) => ipcRenderer.invoke("sheets:loadPeople", payload),
  saveBinaryFile: (payload) => ipcRenderer.invoke("dialog:saveBinaryFile", payload),
  canvaGetStatus: () => ipcRenderer.invoke("canva:getStatus"),
  canvaSaveCredentials: (payload) => ipcRenderer.invoke("canva:saveCredentials", payload),
  canvaLogin: () => ipcRenderer.invoke("canva:login"),
  canvaLogout: () => ipcRenderer.invoke("canva:logout"),
  canvaSendBadgeAutofill: (payload) => ipcRenderer.invoke("canva:sendBadgeAutofill", payload),
  canvaSendPdf: (payload) => ipcRenderer.invoke("canva:sendPdf", payload)
});
