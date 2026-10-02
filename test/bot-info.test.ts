import assert from "node:assert/strict";
import { test } from "node:test";
import { createGetBotInfo } from "@app/modules/telegram/api";
import { buildApp } from "@app/app";
import type { AppConfig } from "@app/config/env";
import type { UserFromGetMe } from "grammy/types";

const info = {
  id: 42,
  is_bot: true,
  first_name: "Synthetic",
  username: "synthetic_bot",
} as UserFromGetMe;

void test("200 simultaneous HTTP requests share one Telegram request and cache its result", async (t) => {
  let release!: (value: UserFromGetMe) => void;
  let calls = 0;
  let time = 0;
  const getBotInfo = createGetBotInfo(
    "synthetic-token",
    {
      getMe: async () => {
        calls++;
        return new Promise<UserFromGetMe>((resolve) => {
          release = resolve;
        });
      },
    },
    () => time,
  );
  const config: AppConfig = {
    nodeEnv: "test",
    host: "127.0.0.1",
    port: 3000,
    logLevel: "silent",
    botToken: "synthetic-token",
    databaseUrl: "postgresql://localhost/synthetic",
    openaiApiKey: "synthetic-key",
    openaiModel: "synthetic-model",
    ownerUsername: "synthetic",
    allowedChatId: -100,
  };
  const app = buildApp(config, { getBotInfo });
  t.after(() => app.close());
  await app.ready();
  const responses = Array.from({ length: 200 }, () => app.inject({ method: "GET", url: "/me" }));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls, 1);
  release(info);
  for (const response of await Promise.all(responses)) {
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json(), info);
  }
  await app.inject({ method: "GET", url: "/me" });
  assert.equal(calls, 1);
  time = 60_000;
  const refresh = getBotInfo();
  await Promise.resolve();
  assert.equal(calls, 2);
  release({ ...info, first_name: "Refreshed" });
  assert.equal((await refresh).first_name, "Refreshed");
});

void test("failed requests release the shared slot and failures are not cached", async () => {
  let calls = 0;
  const getBotInfo = createGetBotInfo("synthetic-token", {
    getMe: async () => {
      if (++calls === 1) throw new Error("Synthetic timeout");
      return info;
    },
  });
  const failed = await Promise.allSettled(Array.from({ length: 20 }, () => getBotInfo()));
  assert.ok(failed.every((result) => result.status === "rejected"));
  assert.equal(calls, 1);
  assert.deepEqual(await getBotInfo(), info);
  assert.equal(calls, 2);
});

void test("Telegram network errors are replaced before Fastify can log their nested token URL", async (t) => {
  const { default: Fastify } = await import("fastify");
  const { Writable } = await import("node:stream");
  const { HttpError } = await import("grammy");
  const { meRoutes } = await import("@app/routes/me");
  const token = "synthetic-secret-token";
  const nested = new Error(`Connection refused https://api.telegram.org/bot${token}/getMe`);
  const original = new HttpError("Synthetic network failure", nested);
  const getBotInfo = createGetBotInfo(token, {
    getMe: async () => {
      throw original;
    },
  });
  await assert.rejects(getBotInfo(), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.equal(error.message, "Telegram bot information unavailable");
    assert.equal(Object.hasOwn(error, "cause"), false);
    assert.equal(Object.hasOwn(error, "error"), false);
    assert.notEqual(error, original);
    return true;
  });
  const logs: string[] = [];
  const stream = new Writable({
    write(chunk, _encoding, done) {
      logs.push(String(chunk));
      done();
    },
  });
  const app = Fastify({ logger: { level: "error", stream } });
  t.after(() => app.close());
  app.register(meRoutes, { getBotInfo });
  const response = await app.inject({ method: "GET", url: "/me" });
  assert.equal(response.statusCode, 500);
  assert.ok(logs.some((line) => line.includes("Telegram bot information unavailable")));
  assert.equal(logs.join("").includes(token), false);
  assert.equal(logs.join("").includes("api.telegram.org"), false);
  assert.equal(response.body.includes(token), false);
  assert.equal(response.body.includes("api.telegram.org"), false);
});
