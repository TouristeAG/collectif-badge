/**
 * Copy Electron main modules next to the asar. Do not extract/repack app.asar
 * (that corrupted CI builds). Do not fail the pack — electron-builder already
 * checks that package.json "main" exists; a wrong .app path here caused
 * false "all modules missing" errors on GitHub runners.
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

function findResourcesDirs(context) {
  const dirs = [];
  const walk = (dir, depth) => {
    if (depth > 5) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "Resources" && fs.existsSync(path.join(full, "app.asar"))) {
          dirs.push(full);
        } else if (entry.name !== "node_modules" && entry.name !== "Frameworks") {
          walk(full, depth + 1);
        }
      }
    }
  };
  if (context.electronPlatformName === "darwin") {
    walk(context.appOutDir, 0);
  } else {
    const win = path.join(context.appOutDir, "resources");
    if (fs.existsSync(win)) dirs.push(win);
  }
  return dirs;
}

function copyElectronModules(destDir, projectElectronDir) {
  fs.mkdirSync(destDir, { recursive: true });
  for (const file of REQUIRED_ELECTRON_MODULES) {
    const src = path.join(projectElectronDir, file);
    if (fs.existsSync(src)) {
      fs.copyFileSync(src, path.join(destDir, file));
    }
  }
}

module.exports = async function electronAfterPack(context) {
  const projectElectronDir = path.join(context.packager.projectDir, "electron");
  const resourcesDirs = findResourcesDirs(context);
  if (!resourcesDirs.length) {
    console.warn("afterPack: no Resources/app.asar found under", context.appOutDir);
    return;
  }
  for (const resourcesDir of resourcesDirs) {
    copyElectronModules(path.join(resourcesDir, "electron-modules"), projectElectronDir);
  }
};
