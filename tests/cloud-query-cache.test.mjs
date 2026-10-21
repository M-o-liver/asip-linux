import { test } from "node:test";
import assert from "node:assert/strict";
import { queryCache } from "../cloud/public/assets/query-cache.js";

test("workspace aggregate queries coalesce, expire, and refresh explicitly", async () => {
  let time = 0,
    calls = 0;
  const cache = queryCache({ now: () => time, ttl: 60000, max: 2 });
  const load = async () => ++calls;
  const first = cache.get("project-one", load);
  assert.equal(cache.get("project-one", load), first);
  assert.equal(await first, 1);
  assert.equal(await cache.get("project-one", load), 1);
  time = 60001;
  assert.equal(await cache.get("project-one", load), 2);
  cache.clear();
  assert.equal(await cache.get("project-one", load), 3);
  await cache.get("project-two", load);
  await cache.get("project-three", load);
  assert.equal(
    await cache.get("project-one", load),
    6,
    "oldest cached project is evicted",
  );
});
test("a failed aggregate query can be retried immediately", async () => {
  const cache = queryCache();
  await assert.rejects(
    cache.get("failed", () => {
      throw Error("Offline");
    }),
    /Offline/,
  );
  assert.equal(await cache.get("failed", async () => "Recovered"), "Recovered");
});
