/**
 * electron-builder afterPack (macOS).
 *
 * The old bash launcher wrap exists only for historical argv workarounds. It is disabled:
 * passing Chromium flags via a stub is unsafe with electron-builder's launcher, and postbuild
 * `codesign --deep` had been re-signing Electron Framework.framework with ad-hoc signatures,
 * which breaks JIT entitlements on macOS 15 (Intel) and causes V8 SIGTRAP at startup.
 * Use `app.commandLine.appendSwitch` in electron/main.cjs instead.
 *
 * Fuses still run after this hook (see package.json build.electronFuses).
 */
module.exports = async function electronAfterPack() {
  /* intentionally empty */
};
