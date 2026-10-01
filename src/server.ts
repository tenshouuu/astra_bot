import "dotenv/config";

import { buildApp } from "@app/app";
import { getConfig } from "@app/config/env";
import { getBotInfo } from "@app/modules/telegram/api";
import { createMemory } from "@app/modules/memory/service";
import { createDatabase, createMemoryStore } from "@app/modules/memory/store";
import { createAsk, createSummarize } from "@app/modules/openai/api";
import { createBot } from "@app/modules/telegram/bot";

const config = getConfig();
const app = buildApp(config);
const database = createDatabase(config.databaseUrl);
const memory = createMemory(createMemoryStore(database), createSummarize(config));
const bot = createBot(config, createAsk(config), memory);
const cleanupTimer = setInterval(
  () => {
    void memory.prune().catch(() => app.log.error("Conversation cleanup failed"));
  },
  60 * 60 * 1000,
);
cleanupTimer.unref();
let shutdownPromise: Promise<void> | undefined;

const shutdown = (signal: NodeJS.Signals): Promise<void> => {
  shutdownPromise ??= (async () => {
    app.log.info({ signal }, "Shutting down");
    if (bot.isRunning()) {
      await bot.stop();
    }
    clearInterval(cleanupTimer);
    await bot.closeRequests();
    await memory.close();
    await database.$disconnect();
    await app.close();
  })();

  return shutdownPromise;
};

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    void shutdown(signal).catch((error: unknown) => {
      app.log.error(error, "Shutdown failed");
      process.exitCode = 1;
    });
  });
}

try {
  await database.$connect();
  await memory.prune();
  await bot.init();
  const botInfo = await getBotInfo(config.botToken);

  app.log.info({ botId: botInfo.id, username: botInfo.username }, "Telegram bot verified");

  app.log.info({ username: bot.botInfo.username }, "Telegram bot initialized");

  await app.listen({ host: config.host, port: config.port });

  await bot.start({
    onStart: () => {
      app.log.info("Telegram bot polling started");
    },
  });
} catch {
  app.log.error("Service startup or polling failed");
  await shutdown("SIGTERM");
  process.exitCode = 1;
}
