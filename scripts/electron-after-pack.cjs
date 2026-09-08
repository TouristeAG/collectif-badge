/**
 * electron-builder afterPack.
 * Inject any missing Electron main modules into app.asar (git/file-set omissions
 * used to ship a dock icon with no window).
 */
const fs = require("fs");
const path = require("path");
const os = require("os");

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
  const variants = [
    relativePath.replace(/\\/g, "/"),
    relativePath.replace(/\\/g, "/").replace(/^\//, ""),
    `/${relativePath.replace(/\\/g, "/").replace(/^\//, "")}`
  ];
  for (const candidate of variants) {
    try {
      Asar.statFile(asarPath, candidate);
      return true;
    } catch {
      /* try next */
    }
  }
  return false;
}

function unpackedHas(resourcesDir, relativePath) {
  return fs.existsSync(path.join(resourcesDir, "app", relativePath));
}

module.exports = async function electronAfterPack(context) {
  const resourcesDir = findResourcesDir(context);
  const asarPath = path.join(resourcesDir, "app.asar");
  const projectElectronDir = path.join(context.packager.projectDir, "electron");

  const missing = REQUIRED_ELECTRON_MODULES.filter((file) => {
    const rel = path.posix.join("electron", file);
    return !asarHas(asarPath, rel) && !unpackedHas(resourcesDir, rel);
  });

  if (missing.length && fs.existsSync(asarPath)) {
    const Asar = require("@electron/asar");
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "collectif-asar-"));
    Asar.extractAll(asarPath, tmp);
    fs.mkdirSync(path.join(tmp, "electron"), { recursive: true });
    for (const file of missing) {
      const src = path.join(projectElectronDir, file);
      if (!fs.existsSync(src)) {
        throw new Error(`Cannot pack ${file}: missing at ${src}`);
      }
      fs.copyFileSync(src, path.join(tmp, "electron", file));
    }
    await Asar.createPackage(tmp, asarPath);
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  const extraDir = path.join(resourcesDir, "electron-modules");
  fs.mkdirSync(extraDir, { recursive: true });
  for (const file of REQUIRED_ELECTRON_MODULES) {
    const src = path.join(projectElectronDir, file);
    if (fs.existsSync(src)) {
      fs.copyFileSync(src, path.join(extraDir, file));
    }
  }

  const stillMissing = REQUIRED_ELECTRON_MODULES.filter((file) => {
    const rel = path.posix.join("electron", file);
    const inAsar = asarHas(asarPath, rel);
    const inUnpacked = unpackedHas(resourcesDir, rel);
    const inExtra = fs.existsSync(path.join(extraDir, file));
    return !inAsar && !inUnpacked && !inExtra;
  });
  if (stillMissing.length) {
    throw new Error(
      `Packaged app is missing required Electron modules:\n  - ${stillMissing.join("\n  - ")}`
    );
  }
};
