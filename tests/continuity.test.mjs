import { test } from "node:test";
import assert from "node:assert/strict";
import { setupState, recallPrompt } from "../cloud/public/assets/continuity.js";
import { continuityState } from "../beacon/continuity.js";

test("cloud setup confirms activity, not clicks or expired device grants", () => {
  const future = new Date(Date.now() + 86400000).toISOString();
  const past = new Date(Date.now() - 86400000).toISOString();
  assert.equal(setupState({}).steps.filter((s) => s.done).length, 0);
  assert.equal(
    setupState({ devices: [{ expires_at: past }] }).connected,
    false,
  );
  assert.equal(
    setupState({ devices: [{ expires_at: future, revoked_at: past }] })
      .connected,
    false,
  );
  const state = setupState({
    devices: [{ expires_at: future }],
    recordCount: 1,
    agents: [{ id: "codex" }],
  });
  assert.ok(state.steps.every((s) => s.done));
  assert.equal(
    setupState({ recordCount: 20, agents: [{ id: "http" }] }).observedAgent,
    false,
  );
  assert.match(
    recallPrompt("github.com/example/site"),
    /github.com\/example\/site/,
  );
});

test("Beacon distinguishes local readiness, pending sync and attention from cloud readiness", () => {
  const state = {
    online: true,
    account: {},
    clients: [{ agent: "codex" }],
    records: 1,
  };
  assert.equal(continuityState({ ...state, online: false }).tone, "attention");
  assert.equal(continuityState({ ...state, account: null }).action, "signin");
  assert.equal(continuityState({ ...state, clients: [] }).action, "agents");
  assert.equal(continuityState(state).tone, "local");
  assert.equal(
    continuityState({ ...state, cloud: { connected: true, pending: 3 } }).tone,
    "syncing",
  );
  assert.equal(
    continuityState({ ...state, cloud: { connected: true, syncing: true } })
      .tone,
    "syncing",
  );
  assert.equal(
    continuityState({
      ...state,
      cloud: { connected: true, error: "Quota pause" },
    }).tone,
    "attention",
  );
  assert.equal(
    continuityState({
      ...state,
      cloud: { connected: true, reconnectRequired: true },
    }).action,
    "cloud",
  );
  assert.equal(
    continuityState({ ...state, cloud: { connected: true } }).tone,
    "ready",
  );
});
