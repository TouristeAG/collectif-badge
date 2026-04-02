"use strict";

const fs = require("fs");
const path = require("path");

/**
 * Chromium switches applied at runtime via app.commandLine.appendSwitch().
 *
 * Do not pass Chromium/V8 flags as argv before init: electron-builder's launcher can mishandle
 * them, and Intel macOS 15 + some Electron lines crash with SIGTRAP if they reach V8 too early.
 * The packaged .app uses the normal CFBundleExecutable (no bash stub; see electron-after-pack).
 *
 * UseRustPng: Intel macOS Rust PNG decoder workaround (not needed on Electron 41+).
 */
const DISABLE_FEATURES = "UseRustPng";

function readBundledPackageJson() {
  try {
    const pkgPath = path.join(__dirname, "..", "package.json");
    return JSON.parse(fs.readFileSync(pkgPath, "utf8"));
  } catch {
    return null;
  }
}

function readBundledElectronMajor() {
  const pkg = readBundledPackageJson();
  if (!pkg) return 0;
  const v = pkg.devDependencies?.electron ?? pkg.dependencies?.electron;
  const m = typeof v === "string" && v.match(/^(\d+)/);
  return m ? parseInt(m[1], 10) : 0;
}

function readBundledAppName() {
  const pkg = readBundledPackageJson();
  return (pkg && pkg.name) || "";
}

module.exports = {
  DISABLE_FEATURES,
  readBundledElectronMajor,
  readBundledAppName,
  mainProcessApply(app) {
    if (!app?.commandLine?.appendSwitch) return;
    app.commandLine.appendSwitch("disable-features", DISABLE_FEATURES);
  },
};
