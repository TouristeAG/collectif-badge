/**
 * Legacy project-root entry. Canonical main is electron/main.cjs (package.json "main").
 * Keep this shim so any accidental `electron main.cjs` / old scripts still load Firebase IPC.
 */
require("./electron/main.cjs");
