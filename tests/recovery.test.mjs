import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { Runtime } from "../beacon/runtime.mjs";
import { Recovery } from "../beacon/recovery.mjs";
import { accountId } from "../beacon/identity.mjs";

function setup(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "asip-recovery-"));
  const runtime = new Runtime(home),
    recovery = new Recovery(runtime);
  t.after(async () => {
    await runtime.close();
    fs.rmSync(home, { recursive: true, force: true });
  });
  const account = {
    provider: "github",
    subject: "42",
    handle: "fixture",
    accountId: accountId("github", "42"),
  };
  function connect() {
    const verifier = crypto.randomBytes(32).toString("hex");
    const challenge = crypto
      .createHash("sha256")
      .update(verifier)
      .digest("hex");
    const request = runtime.requestSignIn({ agent: "codex", challenge });
    runtime.completeSignIn(request.requestId, account);
    return runtime.pollSignIn(request.requestId, verifier).token;
  }
  return { home, runtime, recovery, account, connect };
}
test("recovery retains ten consistent histories and can restore the oldest while preserving current work", (t) => {
  const { runtime, recovery, account, connect } = setup(t);
  assert.throws(() => recovery.list(), /Sign in/);
  runtime.signIn(account);
  assert.throws(() => recovery.save(), /No activity/);
  const token = connect();
  for (let n = 1; n <= 12; n++) {
    runtime.record(token, {
      session: "s1",
      project: "one",
      kind: "evidence",
      summary: "result " + n,
    });
    recovery.save();
  }
  const records = recovery.list();
  assert.equal(records.length, 10);
  assert.equal(records[0].events, 12);
  assert.equal(records[9].events, 3);
  const oldest = records[9].id;
  recovery.restore(oldest);
  assert.equal(runtime.recall(token).events.length, 3);
  assert.equal(recovery.list().length, 10);
  assert.equal(recovery.list()[0].label, "Before restore");
  assert.equal(recovery.list()[0].events, 12);
  assert.equal(
    recovery.list().some((record) => record.id === oldest),
    false,
  );
  runtime.record(token, {
    session: "s1",
    kind: "result",
    summary: "after restore",
  });
  assert.equal(runtime.recall(token).events[0].summary, "after restore");
});
test("recovery checks snapshot integrity before replacement and separates accounts", (t) => {
  const { runtime, recovery, account, connect } = setup(t);
  runtime.signIn(account);
  const token = connect();
  runtime.record(token, { session: "s1", kind: "result", summary: "keep me" });
  const saved = recovery.save()[0];
  fs.appendFileSync(
    path.join(recovery.directory(), saved.id, "activity.sqlite"),
    "changed",
  );
  assert.throws(() => recovery.restore(saved.id), /could not be verified/);
  assert.equal(runtime.recall(token).events[0].summary, "keep me");
  assert.throws(
    () => recovery.restore("../../activity.sqlite"),
    /existing recovery/,
  );
  runtime.signIn({ ...account, accountId: accountId("github", "99") });
  assert.deepEqual(recovery.list(), []);
  assert.throws(() => recovery.restore(saved.id), /existing recovery/);
});
