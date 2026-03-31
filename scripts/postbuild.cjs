#!/usr/bin/env node

const { spawnSync } = require("child_process");

if (process.platform !== "darwin") {
  console.log("Skipping ad-hoc signing (non-macOS platform).");
  process.exit(0);
}

const result = spawnSync("zsh", ["scripts/adhoc-sign-builds.sh"], {
  stdio: "inherit",
});

if (result.error) {
  console.error("Failed to run macOS ad-hoc signing script:", result.error.message);
  process.exit(1);
}

process.exit(result.status ?? 0);
