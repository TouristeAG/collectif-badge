const { app, BrowserWindow, dialog, ipcMain, shell } = require("electron");
const fs = require("fs/promises");
const path = require("path");
const { loadPeopleFromSheets } = require("./sheets.cjs");
const canva = require("./canva.cjs");

const isDev = !app.isPackaged;

function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 980,
    minHeight: 700,
    title: "Collectif Badge Manager",
    backgroundColor: "#0f172a",
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  if (isDev) {
    win.loadURL("http://localhost:5173");
  } else {
    win.loadFile(path.join(__dirname, "..", "dist", "index.html"));
  }
}

ipcMain.handle("dialog:pickServiceAccountKey", async () => {
  const result = await dialog.showOpenDialog({
    title: "Choose Google Service Account JSON",
    properties: ["openFile"],
    filters: [{ name: "JSON", extensions: ["json"] }]
  });

  if (result.canceled || result.filePaths.length === 0) {
    return null;
  }

  return result.filePaths[0];
});

ipcMain.handle("sheets:loadPeople", async (_, payload) => {
  return loadPeopleFromSheets(payload);
});

ipcMain.handle("dialog:saveBinaryFile", async (_, payload) => {
  const { defaultFileName, filters, dataBase64, openAfterSave } = payload ?? {};
  const result = await dialog.showSaveDialog({
    title: "Save export",
    defaultPath: defaultFileName,
    filters: Array.isArray(filters) ? filters : []
  });

  if (result.canceled || !result.filePath) {
    return null;
  }

  const buffer = Buffer.from(dataBase64, "base64");
  await fs.writeFile(result.filePath, buffer);

  if (openAfterSave) {
    await shell.openPath(result.filePath);
  }

  return result.filePath;
});

ipcMain.handle("canva:getStatus", () => canva.getStatus());

ipcMain.handle("canva:saveCredentials", async (_, payload) => {
  await canva.saveCredentials(payload ?? {});
});

ipcMain.handle("canva:login", async () => {
  await canva.startLoginFlow(shell);
});

ipcMain.handle("canva:logout", async () => {
  await canva.logout();
});

ipcMain.handle("canva:sendBadgeAutofill", async (_, payload) => {
  const editUrl = await canva.sendBadgeAutofill(payload ?? {});
  await shell.openExternal(editUrl);
  return { editUrl };
});

/** Fallback when no brand template: import 2-page PDF (flattened badge) into Canva. */
ipcMain.handle("canva:sendPdf", async (_, payload) => {
  const { pdfBase64, title } = payload ?? {};
  if (!pdfBase64 || typeof pdfBase64 !== "string") {
    throw new Error("Missing PDF data.");
  }
  const buffer = Buffer.from(pdfBase64, "base64");
  const editUrl = await canva.importPdfAndGetEditUrl(buffer, title || "Badge");
  await shell.openExternal(editUrl);
  return { editUrl };
});

app.whenReady().then(() => {
  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});
