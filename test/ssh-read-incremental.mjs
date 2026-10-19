// xssh_read incremental mode (upstream 0.4.0 / user 2026-10-20): the default
// "new" read returns only output that arrived since the previous read of the
// same session, so an agent no longer re-reads the whole scrollback after each
// ssh_write. "full" keeps the old behaviour and does not advance the cursor.
import assert from "node:assert/strict";
import SshOpsService from "../src/index.js";

function makeService(maxCaptureBytes = 65536) {
  const service = Object.create(SshOpsService.prototype);
  service.config = { maxBufferBytes: 65536, maxCaptureBytes };
  service.connections = new Map();
  service.sessions = new Map();
  service.activeConnectionId = null;
  return service;
}

function attachSession(service, connectionId, sessionId = "s1") {
  const session = {
    id: sessionId,
    exited: null,
    stream: { write() {} },
    buffer: "",
    captureBuffer: "",
    inputLine: "",
    inputKnown: true,
    waiters: []
  };
  const conn = {
    id: connectionId,
    host: "example",
    username: "root",
    sessions: new Set([sessionId]),
    sftp: null,
    dead: false,
    closing: false
  };
  service.connections.set(connectionId, conn);
  service.sessions.set(sessionId, session);
  service.activeConnectionId = connectionId;
  return session;
}

// ── first read is the whole capture, later reads are incremental ──────────
{
  const service = makeService();
  const session = attachSession(service, "c1");
  session.captureBuffer = "line one\nline two\n";

  const first = service.readCurrentConnection({ connectionId: "c1", mode: "new" });
  assert.equal(first.ok, true);
  assert.match(first.value.data, /line one/);
  assert.match(first.value.data, /line two/);
  assert.equal(first.value.noNewOutput, false, "first read returns the buffered capture");
  assert.equal(first.value.mode, "new");

  session.captureBuffer += "line three\n";
  const second = service.readCurrentConnection({ connectionId: "c1", mode: "new" });
  assert.match(second.value.data, /line three/);
  assert.doesNotMatch(second.value.data, /line one/, "already-read lines are not repeated");

  const third = service.readCurrentConnection({ connectionId: "c1", mode: "new" });
  assert.equal(third.value.noNewOutput, true, "nothing new between reads");
  assert.equal(third.value.data, "");
}

// ── full mode returns everything and does not advance the cursor ──────────
{
  const service = makeService();
  const session = attachSession(service, "c1");
  session.captureBuffer = "alpha\n";
  service.readCurrentConnection({ connectionId: "c1", mode: "new" });

  session.captureBuffer += "beta\n";
  const full = service.readCurrentConnection({ connectionId: "c1", mode: "full" });
  assert.match(full.value.data, /alpha/);
  assert.match(full.value.data, /beta\b/);

  // full never moved the cursor, so the pending line is still "new".
  const next = service.readCurrentConnection({ connectionId: "c1", mode: "new" });
  assert.match(next.value.data, /beta\b/);
  assert.doesNotMatch(next.value.data, /alpha/);
}

// ── capture truncation latches the cursor off, then falls back to full ────
{
  const service = makeService(16);
  const session = attachSession(service, "c1");
  session.captureBuffer = "x".repeat(32); // already at/over the cap
  const first = service.readCurrentConnection({ connectionId: "c1", mode: "new" });
  assert.equal(first.value.truncated, true);
  assert.equal(session.readCursorBroken, true, "truncation marks the cursor unusable");

  session.captureBuffer = "y".repeat(32);
  const second = service.readCurrentConnection({ connectionId: "c1", mode: "new" });
  assert.equal(second.value.cursorBroken, true, "later reads fall back to the full capture");
  assert.match(second.value.data, /y/);
}

// ── no live session still answers shape-correctly ─────────────────────────
{
  const service = makeService();
  const empty = service.readCurrentConnection({ connectionId: "missing", mode: "new" });
  assert.equal(empty.ok, false, "unknown connection is an error, not an empty read");
}

console.log("ssh-read-incremental: first-read, incremental, full-mode and truncation latch all hold");
