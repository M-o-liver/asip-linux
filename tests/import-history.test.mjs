import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { Runtime } from "../beacon/runtime.mjs";
import { Workspace } from "../beacon/workspace.mjs";
import { Recovery } from "../beacon/recovery.mjs";
import { importHistory } from "../beacon/import-history.mjs";

function fixture(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "asip-import-"));
  const file = path.join(home, "previous.sqlite3");
  const old = new DatabaseSync(file);
  old.exec(`
    CREATE TABLE projects(id,name,description,repository,created_at);
    CREATE TABLE roots(path,project_id);
    CREATE TABLE sessions(id,agent,external_id,model,os_user,started_at,last_at,state);
    CREATE TABLE intents(id,session_id,project_id,summary,status,outcome,created_at,updated_at);
    CREATE TABLE events(seq,id,at,session_id,project_id,intent_id,kind,summary,data,source_key,previous_hash,hash);
    CREATE TABLE links(source,target,relation);
    INSERT INTO projects VALUES('p1','Previous project','description','github.com/example/one','2025-01-01');
    INSERT INTO projects VALUES('p2','Quiet project','no events','','2025-01-01');
    INSERT INTO roots VALUES('/projects/one','p1'),('/projects/quiet','p2');
    INSERT INTO sessions VALUES('s1','codex','native-id','model','owner','2025-01-01','2025-01-02','ended');
    INSERT INTO intents VALUES('i1','s1','p1','Finish work','held','Needs a review','2025-01-01','2025-01-02');
    INSERT INTO events VALUES(1,'e1','2025-01-02','s1','p1','i1','intent.held','Needs a review','{"evidence":"old-revision","command":"curl -H Authorization: Bearer old-secret"}','old-key','','old-hash');
    INSERT INTO links VALUES('p1','p2','contains');
  `);
  old.close();
  const runtime = new Runtime(path.join(home, "new"));
  runtime.signIn({
    accountId: "a".repeat(64),
    provider: "github",
    handle: "fixture",
  });
  new Workspace(runtime);
  runtime
    .storage()
    .prepare("INSERT INTO events VALUES(?,?,?,?,?,?,?,?)")
    .run(
      "current",
      "2026-01-01",
      "codex",
      "current-session",
      "result",
      "github.com/example/one",
      "Keep current work",
      "{}",
    );
  t.after(async () => {
    await runtime.close();
    fs.rmSync(home, { recursive: true, force: true });
  });
  return { file, runtime };
}

test("previous workspace import restores quiet projects, history, outcomes, relationships, and recovery without duplicates", (t) => {
  const { file, runtime } = fixture(t);
  const before = crypto
    .createHash("sha256")
    .update(fs.readFileSync(file))
    .digest("hex");
  const recovery = new Recovery(runtime);
  const result = importHistory(runtime, file, {
    checkpoint: () => recovery.save("Before import"),
  });
  assert.deepEqual(result, { projects: 2, events: 1, alreadyImported: false });
  const projects = runtime.projects();
  assert.equal(projects.length, 2);
  assert.equal(projects.find((p) => p.name === "Quiet project").events, 0);
  assert.equal(projects.find((p) => p.name === "Previous project").events, 2);
  const data = runtime.workspace.data(
    new URLSearchParams({ project: "github.com/example/one", kind: "work" }),
  );
  const imported = data.events.find((e) => e.id === "asip3:e1");
  assert.equal(imported.at, "2025-01-02");
  assert.equal(imported.data.importedFrom.intent.outcome, "Needs a review");
  assert.equal(imported.data.importedFrom.hash, "old-hash");
  assert.equal(imported.data.evidence, "old-revision");
  assert.ok(!JSON.stringify(imported).includes("old-secret"));
  assert.deepEqual(data.directories, ["/projects/one"]);
  assert.equal(data.relationships[0].relation, "contains");
  assert.equal(
    runtime.storage().prepare("SELECT count(*) AS n FROM session_details").get()
      .n,
    1,
  );
  assert.equal(recovery.list()[0].events, 1);
  assert.deepEqual(importHistory(runtime, file), {
    projects: 0,
    events: 0,
    alreadyImported: true,
  });
  assert.equal(
    runtime.storage().prepare("SELECT count(*) AS n FROM events").get().n,
    2,
  );
  assert.equal(
    crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex"),
    before,
  );
  recovery.restore(recovery.list()[0].id);
  assert.equal(runtime.projects().length, 1);
  assert.equal(
    runtime.storage().prepare("SELECT count(*) AS n FROM events").get().n,
    1,
  );
});

test("malformed history rolls back the entire import and keeps current work", (t) => {
  const { file, runtime } = fixture(t);
  const old = new DatabaseSync(file);
  old.exec("UPDATE events SET data='not-json'");
  old.close();
  assert.throws(() => importHistory(runtime, file));
  assert.equal(
    runtime.storage().prepare("SELECT count(*) AS n FROM projects").get().n,
    0,
  );
  assert.equal(
    runtime.storage().prepare("SELECT count(*) AS n FROM events").get().n,
    1,
  );
});
