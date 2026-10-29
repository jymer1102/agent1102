// Runs every test suite, one after another, and reports all of them. (`a && b && c` stops at the first failure,
// which hides everything after it.)   run:  npm test
"use strict";
const { spawnSync } = require("child_process");
const path = require("path");

const suites = ["unit", "integration", "client"];
const failed = [];
for (const name of suites) {
  console.log(`\n===== ${name} tests =====`);
  const r = spawnSync(process.execPath, [path.join(__dirname, `${name}.test.js`)], { stdio: "inherit" });
  if (r.status !== 0) failed.push(name);
}
console.log("\n" + (failed.length ? `FAILED: ${failed.join(", ")}` : "All test suites passed."));
process.exit(failed.length ? 1 : 0);
