import assert from "node:assert/strict";
import { test } from "node:test";

import { buildApp } from "../src/app.js";
import type { AppConfig } from "../src/config/env.js";

const testConfig: AppConfig = {
  nodeEnv: "test",
  host: "127.0.0.1",
  port: 3000,
  logLevel: "silent",
};

void test("GET /health reports service health", async (context) => {
  const app = buildApp(testConfig);
  context.after(() => app.close());
  const response = await app.inject({ method: "GET", url: "/health" });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), { status: "ok" });
});
