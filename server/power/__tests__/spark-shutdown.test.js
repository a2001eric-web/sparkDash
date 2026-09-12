import { test } from "node:test";
import { strict as assert } from "node:assert";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const script = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../ops/spark-shutdown");

test("cluster shutdown authorization is scoped, one-shot, and calls only the fake systemctl", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "spark-shutdown-"));
  const authDir = path.join(dir, "auth");
  const marker = path.join(dir, "systemctl.log");
  const fakeSystemctl = path.join(dir, "systemctl");
  fs.writeFileSync(fakeSystemctl, `#!/bin/sh\nprintf '%s\\n' "$*" >> "${marker}"\n`);
  fs.chmodSync(fakeSystemctl, 0o755);
  const env = {
    ...process.env,
    SPARK_POWER_ALLOW_NONROOT: "1",
    SPARK_POWER_AUTH_DIR: authDir,
    SPARK_POWER_SYSTEMCTL: fakeSystemctl,
  };
  const tx = "b".repeat(32);

  execFileSync("bash", [script, "--arm", tx], { env });
  const wrong = spawnSync("bash", [script, "c".repeat(32)], { env, encoding: "utf8" });
  assert.notEqual(wrong.status, 0);
  assert.match(wrong.stderr, /mismatch/);
  assert.equal(fs.existsSync(marker), false);

  execFileSync("bash", [script, tx], { env });
  assert.equal(fs.readFileSync(marker, "utf8").trim(), "poweroff --no-block");
  assert.equal(fs.existsSync(path.join(authDir, "shutdown-authorized")), false);

  const replay = spawnSync("bash", [script, tx], { env, encoding: "utf8" });
  assert.notEqual(replay.status, 0);
  assert.match(replay.stderr, /not armed/);
});
