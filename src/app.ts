import Fastify, { type FastifyInstance } from "fastify";

import type { AppConfig } from "./config/env.js";
import { healthRoutes } from "./routes/health.js";

export function buildApp(config: AppConfig): FastifyInstance {
  const app = Fastify({ logger: { level: config.logLevel } });
  app.register(healthRoutes);
  return app;
}
