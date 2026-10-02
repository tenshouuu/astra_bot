import Fastify, { type FastifyInstance } from "fastify";

import type { AppConfig } from "@app/config/env";
import { healthRoutes } from "@app/routes/health";
import { meRoutes } from "@app/routes/me";
import { createGetBotInfo } from "@app/modules/telegram/api";
import type { UserFromGetMe } from "grammy/types";

export type AppDependencies = Readonly<{
  getBotInfo: () => Promise<UserFromGetMe>;
}>;

export function buildApp(
  config: AppConfig,
  dependencies: AppDependencies = {
    getBotInfo: createGetBotInfo(config.botToken),
  },
): FastifyInstance {
  const app = Fastify({ logger: { level: config.logLevel } });
  app.register(healthRoutes);
  app.register(meRoutes, dependencies);
  return app;
}
