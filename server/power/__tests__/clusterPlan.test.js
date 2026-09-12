import { test } from "node:test";
import { strict as assert } from "node:assert";
import { resolveManagedPair, shutdownManagedPair } from "../clusterPlan.js";

const head = { id: "spark-01", role: "head" };
const worker = { id: "spark-02", role: "worker" };

test("resolveManagedPair rejects ambiguous topology", () => {
  assert.throws(() => resolveManagedPair([head]), /one head and one worker/);
  assert.throws(
    () => resolveManagedPair([head, worker, { id: "worker-2", role: "worker" }]),
    /found 1\/2/,
  );
  assert.deepEqual(resolveManagedPair([worker, head]), { head, worker });
});

test("shutdownManagedPair always submits worker before head", async () => {
  const order = [];
  const results = await shutdownManagedPair(
    { head, worker },
    "a".repeat(32),
    async (spark, transaction) => order.push([spark.id, transaction]),
  );
  assert.deepEqual(order.map(([id]) => id), ["spark-02", "spark-01"]);
  assert.equal(results.every((result) => result.ok), true);
});

test("worker rejection keeps the head online", async () => {
  const order = [];
  const results = await shutdownManagedPair(
    { head, worker },
    "b".repeat(32),
    async (spark) => {
      order.push(spark.id);
      throw new Error("sudo rejected");
    },
  );
  assert.deepEqual(order, ["spark-02"]);
  assert.equal(results[0].ok, false);
  assert.equal(results[1].id, "spark-01");
  assert.equal(results[1].skipped, true);
});
