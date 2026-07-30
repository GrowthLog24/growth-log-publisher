import assert from "node:assert/strict";
import test from "node:test";
import { startKnouHelper } from "../knou-helper.mjs";

test("allows local development and requires pairing for deployed origins", async () => {
  const pairings = new Map([["https://operations.example", "00000000-0000-4000-8000-000000000000"]]);
  const helper = await startKnouHelper({
    port: 0,
    isPairedOrigin: (origin, token) => pairings.get(origin) === token,
    quiet: true,
  });
  const baseUrl = `http://${helper.host}:${helper.port}`;

  try {
    const dashboard = await fetch(`${baseUrl}/`);
    assert.equal(dashboard.status, 200);
    assert.match(await dashboard.text(), /티스토리 임시저장/);

    const zipLibrary = await fetch(`${baseUrl}/vendor/jszip.min.js`);
    assert.equal(zipLibrary.status, 200);
    assert.match(zipLibrary.headers.get("content-type"), /javascript/);

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
    await helper.close();
  }
});
