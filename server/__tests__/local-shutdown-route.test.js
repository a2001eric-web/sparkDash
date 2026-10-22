/**
 * A local Spark's shutdown path spawns spark-shutdown directly. It must resolve
 * "Shutdown initiated" and record the power.shutdown event. A missing `spawn`
 * import here used to throw ReferenceError only on this branch, so the route
 * returned 500 while every remote/cluster test stayed green.
 */
import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";
import { isolatedConfigEnv } from "./isolatedEnv.js";

async function freePort() {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

test("a local Spark shutdown resolves and records power.shutdown", async (t) => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "sparkdash-local-shutdown-"));
  t.after(() => rm(tmp, { recursive: true, force: true }));

  const port = await freePort();
  const child = spawn(process.execPath, ["server/index.js"], {
    cwd: path.resolve(import.meta.dirname, "../.."),
    env: {
      ...process.env,
      ...isolatedConfigEnv(tmp),
      BIND_HOST: "127.0.0.1",
      PORT: String(port),
      SPARKDASH_TOKEN: "",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  t.after(() => child.kill("SIGTERM"));
  let output = "";
  child.stdout.on("data", (chunk) => (output += chunk));
  child.stderr.on("data", (chunk) => (output += chunk));
  await Promise.race([
    new Promise((resolve) => {
      const check = () => (output.includes("server listening") ? resolve() : setTimeout(check, 10));
      check();
    }),
    new Promise((_, reject) => setTimeout(() => reject(new Error(`server did not start:\n${output}`)), 4_000)),
  ]);

  const created = await fetch(`http://127.0.0.1:${port}/api/sparks`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      id: "local",
      name: "local",
      lanIp: "127.0.0.1",
      isLocal: true,
      ssh: { host: "127.0.0.1", user: "spark", auth: "key" },
    }),
  });
  assert.equal(created.status, 200);

  const res = await fetch(`http://127.0.0.1:${port}/api/sparks/local/shutdown`, { method: "POST" });
  assert.equal(res.status, 200, `shutdown route failed:\n${output}`);
  const body = await res.json();
  assert.equal(body.message, "Shutdown initiated");

  // The route answers before running the shutdown (setImmediate), so poll for
  // the event file instead of reading it immediately.
  const eventsFile = path.join(tmp, "events_json_path.json");
  const deadline = Date.now() + 2_000;
  let eventsRaw = "";
  while (Date.now() < deadline) {
    try {
      eventsRaw = await readFile(eventsFile, "utf8");
      break;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  assert.doesNotMatch(output, /ReferenceError/, `shutdown threw:\n${output}`);
  assert.match(eventsRaw, /power\.shutdown/);
});
