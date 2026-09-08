/**
 * electron-builder afterPack.
 * Verify required modules are in app.asar. Do not extract/repack — that
 * produced a corrupt asar on CI ("electron/main.cjs was not found").
 */
const fs = require("fs");
const path = require("path");

const REQUIRED_ELECTRON_MODULES = [
  "main.cjs",
  "preload.cjs",
  "sheets.cjs",
  "canva.cjs",
  "chromium-flags.cjs",
  "firebase-auth.cjs",
  "firebase-join.cjs",
  "firebase-people.cjs"
];

function findResourcesDir(context) {
  if (context.electronPlatformName === "darwin") {
    const apps = fs
      .readdirSync(context.appOutDir)
      .filter((name) => name.endsWith(".app"));
    const preferred = `${context.packager.appInfo.productFilename}.app`;
    const appName = apps.includes(preferred) ? preferred : apps[0];
    if (!appName) {
      throw new Error(`No .app found in ${context.appOutDir}`);
    }
    return path.join(context.appOutDir, appName, "Contents", "Resources");
  }
  return path.join(context.appOutDir, "resources");
}

function asarHas(asarPath, relativePath) {
  if (!fs.existsSync(asarPath)) return false;
  const Asar = require("@electron/asar");
  try {
    Asar.statFile(asarPath, relativePath.replace(/\\/g, "/"), false);
    return true;
  } catch {
    return false;
  }
}

module.exports = async function electronAfterPack(context) {
  const resourcesDir = findResourcesDir(context);
  const asarPath = path.join(resourcesDir, "app.asar");
  const projectElectronDir = path.join(context.packager.projectDir, "electron");

  const extraDir = path.join(resourcesDir, "electron-modules");
  fs.mkdirSync(extraDir, { recursive: true });
  for (const file of REQUIRED_ELECTRON_MODULES) {
    const src = path.join(projectElectronDir, file);
    if (fs.existsSync(src)) {
      fs.copyFileSync(src, path.join(extraDir, file));
    }
  }

  const missing = REQUIRED_ELECTRON_MODULES.filter((file) => {
    const rel = path.posix.join("electron", file);
    return !asarHas(asarPath, rel) && !fs.existsSync(path.join(resourcesDir, "app", rel));
  });
  if (missing.length) {
    throw new Error(
      `Packaged app.asar is missing required Electron modules:\n  - ${missing.join("\n  - ")}\n` +
        "Check build.files includes electron/**/*."
    );
  }
};
