#!/usr/bin/env node

const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const packageJsonPath = path.join(root, "package.json");
const versionJsonPath = path.join(root, "version.json");

function normalizeVersion(value) {
  return String(value ?? "").trim().replace(/^v/i, "");
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

const packageJson = readJson(packageJsonPath);
const versionJson = readJson(versionJsonPath);

const packageVersion = normalizeVersion(packageJson.version);
const releaseVersion = normalizeVersion(versionJson.version);

if (!releaseVersion) {
  console.error("Version sync failed: missing version in version.json.");
  process.exit(1);
}

if (packageVersion === releaseVersion) {
  console.log(`Version already synced (${releaseVersion}).`);
  process.exit(0);
}

packageJson.version = releaseVersion;
fs.writeFileSync(packageJsonPath, `${JSON.stringify(packageJson, null, 2)}\n`, "utf8");
console.log(`Synced package.json version: ${packageVersion || "<empty>"} -> ${releaseVersion}`);
