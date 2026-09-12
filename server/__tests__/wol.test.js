import { test } from "node:test";
import { strict as assert } from "node:assert";
import { sendWolBurst } from "../wol.js";

test("sendWolBurst sends three packets with bounded gaps", async () => {
  const sends = [];
  const sleeps = [];
  const result = await sendWolBurst(
    "aa:bb:cc:dd:ee:ff",
    "192.168.1.255",
    3,
    250,
    async (mac, broadcast) => {
      sends.push({ mac, broadcast });
      return { mac, broadcast };
    },
    async (delay) => sleeps.push(delay),
  );
  assert.equal(sends.length, 3);
  assert.deepEqual(sleeps, [250, 250]);
  assert.equal(result.packets, 3);
  assert.equal(result.broadcast, "192.168.1.255");
});
