import "dotenv/config";
import { bot } from '@app/modules/telegram/bot';

import { buildApp } from "./app.js";
import { getConfig } from "@app/config/env";
import { getBotInfo } from '@app/modules/telegram/api';

const config = getConfig();
const app = buildApp(config);

const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
  app.log.info({ signal }, "Shutting down");
  await app.close();
};

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => void shutdown(signal));
}

try {
  await bot.init();
  const botInfo = await getBotInfo(config.botToken);

  app.log.info(
    { botId: botInfo.id, username: botInfo.username },
    "Telegram bot verified",
  );

  app.log.info(
    { username: bot.botInfo.username },
    "Telegram bot initialized",
  );

  await app.listen({ host: config.host, port: config.port });

  await bot.start({
    onStart: () => {
      app.log.info("Telegram bot polling started");
    },
  });
} catch (error) {
  app.log.error(error);
  process.exitCode = 1;
}
