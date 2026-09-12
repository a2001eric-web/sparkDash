import { test } from "node:test";
import { strict as assert } from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ClusterPowerCoordinator } from "../ClusterPowerCoordinator.js";

function fixture(responses) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sparkdash-power-"));
  const calls = [];
  const execFileFn = (helper, args, options, callback) => {
    calls.push({ helper, args, options });
    const next = responses.shift();
    queueMicrotask(() => {
      if (next instanceof Error) callback(next, "", next.message);
      else callback(null, `${JSON.stringify(next)}\n`, "");
    });
  };
  return {
    calls,
    statePath: path.join(dir, "power-operation.json"),
    coordinator: new ClusterPowerCoordinator({
      helperPath: process.execPath,
      statePath: path.join(dir, "power-operation.json"),
      execFileFn,
    }),
  };
}

test("prepare persists saved model and validates the power transaction", async () => {
  const tx = "a".repeat(32);
  const { coordinator, calls, statePath } = fixture([
    { action: "prepare", model: "glm53", transaction_id: tx },
  ]);
  const receipt = await coordinator.prepareShutdown();
  assert.equal(receipt.transaction_id, tx);
  assert.deepEqual(calls.map((call) => call.args), [["prepare"]]);
  assert.equal(coordinator.status().phase, "poweroff");
  assert.equal(coordinator.status().resumeModel, "glm53");
  assert.equal(JSON.parse(fs.readFileSync(statePath, "utf8")).resumeModel, "glm53");

  const final = coordinator.recordShutdown([
    { id: "worker", ok: true },
    { id: "head", ok: true },
  ]);
  assert.equal(final.status, "suspended");
  assert.match(final.message, /Wake All/);
});

test("prepare fails closed on an invalid transaction receipt", async () => {
  const { coordinator } = fixture([
    { action: "prepare", model: "glm53", transaction_id: "unsafe" },
  ]);
  await assert.rejects(() => coordinator.prepareShutdown(), /invalid power transaction/i);
  assert.equal(coordinator.status().status, "failed");
  assert.equal(coordinator.status().phase, "prepare-failed");
});

test("resume is single-flight and stores canonical readiness success", async () => {
  const { coordinator, calls } = fixture([
    { action: "resume", model: "deepseek-v4-flash-0731" },
  ]);
  const first = coordinator.startResume();
  const second = coordinator.startResume();
  assert.equal(first.status, "running");
  assert.equal(second.status, "running");
  await coordinator.waitForResumeForTest();
  assert.deepEqual(calls.map((call) => call.args), [["resume"]]);
  assert.equal(coordinator.status().status, "success");
  assert.equal(coordinator.status().resumeModel, "deepseek-v4-flash-0731");
});

test("resume failure remains visible and retryable", async () => {
  const { coordinator, calls } = fixture([
    new Error("fabric did not recover"),
    { action: "resume", model: "glm53" },
  ]);
  coordinator.startResume();
  await coordinator.waitForResumeForTest();
  assert.equal(coordinator.status().status, "failed");
  assert.match(coordinator.status().message, /fabric/);

  coordinator.startResume();
  await coordinator.waitForResumeForTest();
  assert.equal(coordinator.status().status, "success");
  assert.equal(calls.length, 2);
});

test("a dashboard restart converts an in-flight operation into retryable failure", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sparkdash-power-restart-"));
  const statePath = path.join(dir, "power-operation.json");
  fs.writeFileSync(
    statePath,
    JSON.stringify({
      action: "resume",
      status: "running",
      phase: "waiting-for-hosts",
      message: "waiting",
      resumeModel: "glm53",
    }),
  );
  const coordinator = new ClusterPowerCoordinator({
    helperPath: process.execPath,
    statePath,
  });
  assert.equal(coordinator.status().status, "failed");
  assert.equal(coordinator.status().phase, "interrupted");
  assert.match(coordinator.status().message, /retry/i);
});

test("Wake-on-LAN failure is durable and does not claim model restore", () => {
  const { coordinator } = fixture([]);
  const status = coordinator.recordWakeFailure("worker wake failed");
  assert.equal(status.status, "failed");
  assert.equal(status.phase, "wake-failed");
  assert.match(status.message, /worker/);
});
