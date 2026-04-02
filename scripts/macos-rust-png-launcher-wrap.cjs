/**
 * Renames the real CFBundleExecutable to .collectif-badge-real and installs a
 * thin bash stub that execs it. No Chromium/V8 flags are passed via argv because
 * electron-builder's custom launcher rejects them and they trigger a V8 DCHECK
 * crash on Intel macOS 15.x. All feature flags are applied at runtime in main.cjs.
 */
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const WRAPPER_INNER = ".collectif-badge-real";

function readBundleExecutable(appPath) {
  const plist = path.join(appPath, "Contents", "Info.plist");
  if (!fs.existsSync(plist)) return null;
  try {
    return execFileSync(
      "/usr/libexec/PlistBuddy",
      ["-c", "Print :CFBundleExecutable", plist],
      { encoding: "utf8" }
    ).trim();
  } catch {
    return null;
  }
}

function launcherLooksLikeScript(filePath) {
  const fd = fs.openSync(filePath, "r");
  try {
    const buf = Buffer.alloc(256);
    const n = fs.readSync(fd, buf, 0, 256, 0);
    const head = buf.slice(0, n).toString("utf8");
    return head.startsWith("#!") && /sh|bash|zsh/.test(head.slice(0, 40));
  } finally {
    fs.closeSync(fd);
  }
}

function wrapMacosLauncher(appPath) {
  const plist = path.join(appPath, "Contents", "Info.plist");
  const macos = path.join(appPath, "Contents", "MacOS");
  if (!fs.existsSync(plist) || !fs.existsSync(macos)) return;

  const execName = readBundleExecutable(appPath);
  if (!execName) return;

  const realPath = path.join(macos, WRAPPER_INNER);
  const launcher = path.join(macos, execName);

  if (!fs.existsSync(launcher)) {
    console.warn(`  Warning: missing CFBundleExecutable at ${launcher} — skip wrap.`);
    return;
  }

  // Chromium/V8 flags must NOT be passed as argv to the electron-builder custom launcher
  // because it rejects unrecognized options ("bad option"). On Intel macOS 15.x this also
  // triggers a V8 DCHECK crash when flags DO reach V8 through LaunchServices launches.
  // All feature flags are applied at runtime via app.commandLine.appendSwitch() in main.cjs.
  const wrapper = `#!/bin/bash
DIR="$(cd "$(dirname "$0")" && pwd)"
exec "$DIR/${WRAPPER_INNER}" "$@"
`;

  const stubHint = "";

  if (fs.existsSync(realPath)) {
    if (!launcherLooksLikeScript(launcher)) {
      console.warn(
        `  Warning: ${WRAPPER_INNER} exists but ${launcher} is not a script — skip (broken bundle?).`
      );
      return;
    }
    fs.writeFileSync(launcher, wrapper, { encoding: "utf8" });
    fs.chmodSync(launcher, 0o755);
    console.log(`  Refreshed macOS launcher stub: ${appPath}`);
    return;
  }
  if (launcherLooksLikeScript(launcher)) {
    console.warn(`  Warning: ${launcher} is already a script but no ${WRAPPER_INNER} — skip wrap.`);
    return;
  }

  fs.renameSync(launcher, realPath);
  fs.writeFileSync(launcher, wrapper, { encoding: "utf8" });
  fs.chmodSync(launcher, 0o755);
  fs.chmodSync(realPath, 0o755);
  console.log(`  Wrapped macOS launcher (UseRustPng${stubHint}): ${appPath}`);
}

module.exports = { wrapMacosLauncher, WRAPPER_INNER };

if (require.main === module) {
  const target = process.argv[2];
  if (target) wrapMacosLauncher(path.resolve(target));
  else process.exitCode = 1;
}
