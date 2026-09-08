/**
 * electron-builder afterPack.
 * Fail the build if required Electron main modules are missing from the asar
 * (that used to ship a dock/taskbar icon with no window).
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

function existsInResources(resourcesDir, relativePath) {
  const asarUnpacked = path.join(resourcesDir, "app.asar.unpacked", relativePath);
  const loose = path.join(resourcesDir, "app", relativePath);
  if (fs.existsSync(asarUnpacked) || fs.existsSync(loose)) return true;
  try {
    const Asar = require("@electron/asar");
    const asarPath = path.join(resourcesDir, "app.asar");
    if (!fs.existsSync(asarPath)) return false;
    Asar.statFile(asarPath, relativePath.replace(/\\/g, "/"));
    return true;
  } catch {
    return false;
  }
}

module.exports = async function electronAfterPack(context) {
  const resourcesDir =
    context.electronPlatformName === "darwin"
      ? path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`, "Contents", "Resources")
      : path.join(context.appOutDir, "resources");

  const missing = [];
  for (const file of REQUIRED_ELECTRON_MODULES) {
    const rel = path.posix.join("electron", file);
    if (!existsInResources(resourcesDir, rel)) missing.push(rel);
  }
  if (missing.length) {
    throw new Error(
      `Packaged app is missing required Electron modules:\n  - ${missing.join("\n  - ")}\n` +
        "The window will never open. Check build.files includes electron/*.cjs."
    );
  }
};
