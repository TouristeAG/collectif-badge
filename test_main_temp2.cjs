const fs = require("fs");
// Try different ways to require electron
let apiFound = false;
try {
  const e1 = process.electronBinding ? process.electronBinding("app") : null;
  fs.appendFileSync("/tmp/electron_test2.txt", `electronBinding: ${typeof e1}\n`);
} catch(err) {
  fs.appendFileSync("/tmp/electron_test2.txt", `electronBinding error: ${err.message}\n`);
}
try {
  const binding = process._linkedBinding ? process._linkedBinding("electron_browser_app") : null;
  fs.appendFileSync("/tmp/electron_test2.txt", `_linkedBinding app: ${typeof binding}\n`);
} catch(err) {
  fs.appendFileSync("/tmp/electron_test2.txt", `_linkedBinding error: ${err.message}\n`);
}
// Check process.versions for electron
fs.appendFileSync("/tmp/electron_test2.txt", `process.versions.electron: ${process.versions?.electron}\n`);
// List all available bindings
try {
  const allKeys = Object.keys(process);
  fs.appendFileSync("/tmp/electron_test2.txt", `process keys: ${JSON.stringify(allKeys.filter(k => k.includes('electron') || k.includes('Binding')))}\n`);
} catch(err) {}
process.exit(0);
