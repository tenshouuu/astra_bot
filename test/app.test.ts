import assert from "node:assert/strict";
import { test } from "node:test";

import { buildApp } from "@app/app";
import type { AppConfig } from "@app/config/env";

const testConfig: AppConfig = {
  nodeEnv: "test",
  host: "127.0.0.1",
  port: 3000,
  logLevel: "silent",
  botToken: "test-token",
};

void test("GET /health reports service health", async (context) => {
  const app = buildApp(testConfig);
  context.after(() => app.close());
  const response = await app.inject({ method: "GET", url: "/health" });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), { status: "ok" });
});

void test("GET /me returns Telegram bot information", async (context) => {
  const botInfo = {
    id: 42,
    is_bot: true as const,
    first_name: "Astra",
    username: "astra_bot",
    can_join_groups: true,
    can_read_all_group_messages: false,
    supports_inline_queries: false,
    can_connect_to_business: false,
    has_main_web_app: false,
    has_topics_enabled: false,
    allows_users_to_create_topics: false,
    can_manage_bots: false,
    supports_join_request_queries: false,
  };
  const app = buildApp(testConfig, { getBotInfo: async () => botInfo });
  context.after(() => app.close());

  const response = await app.inject({ method: "GET", url: "/me" });

  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), botInfo);
});
