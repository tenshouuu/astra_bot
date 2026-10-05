import "dotenv/config";

import { buildApp } from "@app/app";
import { getConfig } from "@app/config/env";
import { createGetBotInfo } from "@app/modules/telegram/api";
import { createMemory } from "@app/modules/memory/service";
import { createDatabase, createMemoryStore } from "@app/modules/memory/store";
import { createAsk, createSummarize } from "@app/modules/openai/api";
import { createBot } from "@app/modules/telegram/bot";
import { createClassify } from "@app/modules/openai/moderation";
import { createModerationStore } from "@app/modules/moderation/store";
import { createBanAnnouncement } from "@app/modules/openai/ban-announcement";
import { createDetectAddress } from "@app/modules/openai/address";

const config = getConfig();
const getBotInfo = createGetBotInfo(config.botToken);
const app = buildApp(config, { getBotInfo });
const database = createDatabase(config.databaseUrl);
const memory = createMemory(createMemoryStore(database), createSummarize(config));
const bot = createBot(
  config,
  createAsk(config),
  memory,
  config.moderationEnabled
    ? {
        store: createModerationStore(database),
        classify: createClassify(config),
        generateBanAnnouncement: createBanAnnouncement(config),
      }
    : undefined,
  createDetectAddress(config),
);
const cleanupTimer = setInterval(
  () => {
    void memory.prune().catch(() => app.log.error("Conversation cleanup failed"));
    void bot.pruneModeration().catch(() => app.log.error("Moderation cleanup failed"));
  },
  60 * 60 * 1000,
);
cleanupTimer.unref();
let shutdownPromise: Promise<void> | undefined;
let polling: Promise<void> | undefined;

const shutdown = (signal: NodeJS.Signals): Promise<void> => {
  shutdownPromise ??= (async () => {
    app.log.info({ signal }, "Shutting down");
    if (bot.isRunning()) {
      await bot.stop().catch(() => app.log.error("Telegram polling stop failed"));
    }
    clearInterval(cleanupTimer);
    // stop() cancels polling but does not wait for the current middleware stack.
    await polling?.catch(() => undefined);
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
  await bot.startModeration();
  if (!config.moderationEnabled) app.log.info({ enabled: false }, "Moderation monitoring disabled");
  const botInfo = await getBotInfo();

  app.log.info({ botId: botInfo.id, username: botInfo.username }, "Telegram bot verified");

  app.log.info(
    {
      username: bot.botInfo.username,
      privacyModeEnabled: !bot.botInfo.can_read_all_group_messages,
    },
    "Telegram bot initialized",
  );

  await app.listen({ host: config.host, port: config.port });

  polling = bot.start({
    timeout: 10,
    onStart: () => {
      app.log.info("Telegram bot polling started");
    },
  });
  await polling;
} catch {
  app.log.error("Service startup or polling failed");
  await shutdown("SIGTERM");
  process.exitCode = 1;
}
