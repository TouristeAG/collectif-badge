const fs = require("fs");
const e = require("electron");
const type = typeof e;
fs.appendFileSync("/tmp/electron_test_result.txt", 
  `type=${type} app=${typeof e?.app}\n`
);
if (typeof e?.app === "object") {
  e.app.whenReady().then(() => { e.app.quit(); });
} else {
  fs.appendFileSync("/tmp/electron_test_result.txt", `e=${String(e).substring(0,100)}\n`);
  process.exit(0);
}
