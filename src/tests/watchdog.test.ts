import test from "node:test";
import assert from "node:assert";
import { classifyHeapUsage } from "../core/watchdog.ts";

test("watchdog classifies RAM against the V8 heap limit", () => {
  assert.equal(classifyHeapUsage(950, 10_000, 80, 95), "ok");
  assert.equal(classifyHeapUsage(8_500, 10_000, 80, 95), "warning");
  assert.equal(classifyHeapUsage(9_600, 10_000, 80, 95), "critical");
});
