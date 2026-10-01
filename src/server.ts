import "dotenv/config";

import { buildApp } from "./app.js";
import { getConfig } from "@app/config/env";
import { getBotInfo } from '@app/telegram';

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
  const bot = await getBotInfo(config.botToken);

  app.log.info(
    { botId: bot.id, username: bot.username },
    "Telegram bot verified",
  );

  await app.listen({ host: config.host, port: config.port });
} catch (error) {
  app.log.error(error);
  process.exitCode = 1;
}
