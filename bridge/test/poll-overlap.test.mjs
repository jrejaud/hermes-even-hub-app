/**
 * SC-8063: both pollers ran `setInterval(() => void this.tick())`, so when a host
 * answered slower than the interval (Overlord's /api/sessions took up to 6 s,
 * the client timeout is 15 s) ticks stacked up — about one request a second
 * against a 5 s poll — and filled Overlord's accept backlog. A tick still in
 * flight must make the next interval a no-op.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { NotificationFeed } from "../notifications.mjs";
import { ActivityWatcher } from "../fleet.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Replace tick with a slow one and report the most ticks ever in flight at once. */
function slowTick(poller) {
  const stats = { inFlight: 0, max: 0, calls: 0 };
  poller.tick = async () => {
    stats.calls++;
    stats.inFlight++;
    stats.max = Math.max(stats.max, stats.inFlight);
    await sleep(300);
    stats.inFlight--;
  };
  return stats;
}

test("NotificationFeed never runs two ticks at once against a slow host", async () => {
  const feed = new NotificationFeed([{ key: "ov", name: "overlord", flaggedUrl: "http://127.0.0.1:9", flaggedToken: "t" }], { intervalMs: 50 });
  const stats = slowTick(feed);
  feed.start();
  await sleep(1000);
  feed.stop();
  assert.equal(stats.max, 1, `ticks in flight at once: ${stats.max}`);
  assert.ok(stats.calls >= 2, "it keeps polling once the slow tick settles");
});

test("ActivityWatcher never runs two ticks at once against a slow host", async () => {
  const watcher = new ActivityWatcher({ sessions: async () => [] }, { intervalMs: 50 });
  const stats = slowTick(watcher);
  watcher.start();
  await sleep(1000);
  watcher.stop();
  assert.equal(stats.max, 1, `ticks in flight at once: ${stats.max}`);
  assert.ok(stats.calls >= 2, "it keeps polling once the slow tick settles");
});
