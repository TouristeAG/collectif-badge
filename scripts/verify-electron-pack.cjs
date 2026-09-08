#!/usr/bin/env node
/**
 * Fail CI if Electron main modules are missing from the checkout or from
 * packaged app.asar. Tag 1.5.0 shipped without firebase-*.cjs and the
 * GitHub installers opened no window.
 */
const fs = require("fs");
const path = require("path");

const REQUIRED = [
  "electron/main.cjs",
  "electron/preload.cjs",
  "electron/sheets.cjs",
  "electron/canva.cjs",
  "electron/chromium-flags.cjs",
  "electron/firebase-auth.cjs",
  "electron/firebase-join.cjs",
  "electron/firebase-people.cjs"
];

function asarHas(asarPath, rel) {
  const Asar = require("@electron/asar");
  const variants = [rel, rel.replace(/^\//, ""), `/${rel.replace(/^\//, "")}`];
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

function findAsars(root) {
  const found = [];
  const walk = (dir, depth) => {
    if (depth > 8) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name === "node_modules" || entry.name === ".git") continue;
      const full = path.join(dir, entry.name);
      if (entry.isFile() && entry.name === "app.asar") found.push(full);
      else if (entry.isDirectory()) walk(full, depth + 1);
    }
  };
  walk(root, 0);
  return found;
}

function verifySources() {
  const missing = REQUIRED.filter((rel) => !fs.existsSync(path.join(process.cwd(), rel)));
  if (missing.length) {
    console.error(
      "This git ref is missing Electron modules required at startup:\n  - " +
        missing.join("\n  - ") +
        "\n\nThe GitHub installer will show a dock/taskbar icon and no window.\n" +
        "Commit these files, then tag (or Run workflow from main). Do not release an older tag that lacks them."
    );
    process.exit(1);
  }
  console.log("Electron source modules OK:\n  " + REQUIRED.join("\n  "));
}

function verifyAsar() {
  const releaseDir = path.join(process.cwd(), "release");
  const asars = findAsars(releaseDir);
  if (!asars.length) {
    console.error("No app.asar found under release/. Packaging did not produce an app.");
    process.exit(1);
  }
  let failed = false;
  for (const asarPath of asars) {
    const missing = REQUIRED.filter((rel) => !asarHas(asarPath, rel));
    if (missing.length) {
      failed = true;
      console.error(`Missing in ${asarPath}:\n  - ${missing.join("\n  - ")}`);
    } else {
      console.log(`OK ${path.relative(process.cwd(), asarPath)}`);
    }
  }
  if (failed) {
    console.error("Packaged app.asar is incomplete. Refusing to publish.");
    process.exit(1);
  }
}

const mode = process.argv[2] || "sources";
if (mode === "asar") verifyAsar();
else if (mode === "sources") verifySources();
else {
  console.error("Usage: node scripts/verify-electron-pack.cjs <sources|asar>");
  process.exit(2);
}
