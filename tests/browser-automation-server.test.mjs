import assert from "node:assert/strict";
import test from "node:test";
import { createBrowserTaskQueue, startBrowserAutomation } from "../browser-automation.mjs";

test("runs concurrent browser requests one at a time and continues after a failure", async () => {
  const queue = createBrowserTaskQueue();
  const order = [];
  let active = 0;
  let maxActive = 0;
  const run = (name, fail = false) => queue.run(async () => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    order.push(`${name}:start`);
    await new Promise((resolve) => setTimeout(resolve, 15));
    active -= 1;
    if (fail) throw new Error(`${name} failed`);
    order.push(`${name}:end`);
    return name;
  });

  const first = run("first");
  const second = run("second", true);
  const third = run("third");

  assert.equal(await first, "first");
  await assert.rejects(second, /second failed/);
  assert.equal(await third, "third");
  assert.equal(maxActive, 1);
  assert.deepEqual(order, ["first:start", "first:end", "second:start", "third:start", "third:end"]);
  assert.equal(queue.pending, 0);
});

test("allows local development and requires pairing for deployed origins", async () => {
  const pairings = new Map([["https://operations.example", "00000000-0000-4000-8000-000000000000"]]);
  const automation = await startBrowserAutomation({
    port: 0,
    isPairedOrigin: (origin, token) => pairings.get(origin) === token,
    quiet: true,
  });
  const baseUrl = `http://${automation.host}:${automation.port}`;

  try {
    const removedDashboard = await fetch(`${baseUrl}/`);
    assert.equal(removedDashboard.status, 404);

    const removedZipLibrary = await fetch(`${baseUrl}/vendor/jszip.min.js`);
    assert.equal(removedZipLibrary.status, 404);

    const localHealth = await fetch(`${baseUrl}/health`, {
      headers: { Origin: "http://localhost:3000" },
    });
    assert.equal(localHealth.status, 200);
    assert.equal((await localHealth.json()).authorized, true);

    const unpairedHealth = await fetch(`${baseUrl}/health`, {
      headers: { Origin: "https://operations.example" },
    });
    assert.equal(unpairedHealth.status, 200);
    assert.equal((await unpairedHealth.json()).authorized, false);

    const blockedCommand = await fetch(`${baseUrl}/login`, {
      method: "POST",
      headers: {
        Origin: "https://operations.example",
        "Content-Type": "application/json",
      },
    });
    assert.equal(blockedCommand.status, 403);
    assert.equal((await blockedCommand.json()).code, "PAIRING_REQUIRED");

    const pairedHealth = await fetch(`${baseUrl}/health`, {
      headers: {
        Origin: "https://operations.example",
        "X-Growth-Log-Token": pairings.get("https://operations.example"),
      },
    });
    assert.equal(pairedHealth.status, 200);
    assert.equal((await pairedHealth.json()).authorized, true);

    const sameOriginHealth = await fetch(`${baseUrl}/health`, {
      headers: { Origin: baseUrl },
    });
    assert.equal(sameOriginHealth.status, 200);
    assert.equal((await sameOriginHealth.json()).authorized, true);
  } finally {
    await automation.close();
  }
});
