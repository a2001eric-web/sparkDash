/** Resolve the only supported managed topology without guessing by array order. */
export function resolveManagedPair(sparks) {
  const heads = sparks.filter((spark) => spark.role === "head");
  const workers = sparks.filter((spark) => spark.role === "worker");
  if (heads.length !== 1 || workers.length !== 1) {
    throw new Error(
      `Cluster power requires exactly one head and one worker (found ${heads.length}/${workers.length})`,
    );
  }
  return { head: heads[0], worker: workers[0] };
}

/**
 * Submit worker poweroff before head. If the worker command is rejected, the
 * head deliberately remains online so the failure stays observable/recoverable.
 */
export async function shutdownManagedPair(pair, transactionId, shutdownFn) {
  const results = [];
  for (const spark of [pair.worker, pair.head]) {
    try {
      await shutdownFn(spark, transactionId);
      results.push({ id: spark.id, ok: true, message: "Shutdown initiated" });
    } catch (error) {
      results.push({
        id: spark.id,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
      if (spark.id === pair.worker.id) {
        results.push({
          id: pair.head.id,
          ok: false,
          skipped: true,
          error: "Worker shutdown failed; head was deliberately kept online",
        });
        break;
      }
    }
  }
  return results;
}
