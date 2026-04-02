#!/usr/bin/env node
/**
 * Sync npm package version from version.json (single source of truth for releases).
 *
 * Workflow:
 *   1. Edit only `version.json` when you want to ship a new version (bump `version`,
 *      and adjust `minRequiredVersion` / `notes` / etc. as needed).
 *   2. Run a build (`npm run build` or `npm run build:web`) — this script runs first and
 *      copies `version.json` → `package.json` so electron-builder, Vite, and the app match.
 *   3. Commit both `version.json` and the updated `package.json` (or let CI commit if you prefer).
 *
 * Manual run: `npm run sync:version`
 *
 * Options:
 *   --dry-run   Print actions only; do not write package.json
 */

const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const packageJsonPath = path.join(root, "package.json");
const versionJsonPath = path.join(root, "version.json");

const dryRun = process.argv.includes("--dry-run");

function normalizeVersion(value) {
  return String(value ?? "").trim().replace(/^v/i, "");
}

/** Loose semver x.y.z so we catch obvious mistakes without blocking odd prerelease tags */
function isPlausibleVersion(v) {
  return /^\d+\.\d+\.\d+([.-][0-9A-Za-z.-]+)?$/.test(v);
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

if (!fs.existsSync(versionJsonPath)) {
  console.error("sync-package-version: missing version.json at repo root.");
  process.exit(1);
}

const packageJson = readJson(packageJsonPath);
const versionJson = readJson(versionJsonPath);

const packageVersion = normalizeVersion(packageJson.version);
const releaseVersion = normalizeVersion(versionJson.version);

if (!releaseVersion) {
  console.error("sync-package-version: version.json must contain a non-empty \"version\" field.");
  process.exit(1);
}

if (!isPlausibleVersion(releaseVersion)) {
  console.warn(`sync-package-version: warning: "${releaseVersion}" does not look like semver (continuing anyway).`);
}

if (packageVersion === releaseVersion) {
  console.log(`sync-package-version: package.json already at ${releaseVersion}.`);
  process.exit(0);
}

if (dryRun) {
  console.log(`sync-package-version: [dry-run] would set package.json version: ${packageVersion || "<empty>"} -> ${releaseVersion}`);
  process.exit(0);
}

packageJson.version = releaseVersion;
fs.writeFileSync(packageJsonPath, `${JSON.stringify(packageJson, null, 2)}\n`, "utf8");
console.log(`sync-package-version: updated package.json ${packageVersion || "<empty>"} -> ${releaseVersion}`);
