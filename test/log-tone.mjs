// Session-log line classification (upstream 0.4.0): error lines red, warning
// lines amber in the log viewer. Pure text heuristics - deliberately eager
// ("0 errors" is still an error-toned line, like grep --color).
import assert from "node:assert/strict";
import { logLineTone } from "../src/client/log-tone.js";

const errorLines = [
  "2026-10-20 03:00:01 ERROR connection refused",
  "Traceback (most recent call last):",
  "python3: Exception in thread main",
  "fatal: not a git repository",
  "EACCES: permission denied",
  "nginx: [emerg] bind() to 0.0.0.0:80 failed",
  "0 errors, 0 warnings"
];

const warnLines = [
  "warning: deprecated API usage",
  "WARN  cache expired, retrying",
  "security: [warn] something",
  "This warning can be ignored"
];

const plainLines = [
  "root@iStoreOS:~# ls -la",
  "total 42",
  "drwxr-xr-x  3 root root 4096 Oct 20 02:00 .",
  ""
];

for (const line of errorLines) assert.equal(logLineTone(line), "error", `expected error: ${line}`);
for (const line of warnLines) assert.equal(logLineTone(line), "warn", `expected warn: ${line}`);
for (const line of plainLines) assert.equal(logLineTone(line), null, `expected plain: ${line}`);
assert.equal(logLineTone(null), null);

console.log("log-tone: error / warn / plain classification holds");
