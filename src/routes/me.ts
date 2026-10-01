import type { FastifyPluginCallback } from "fastify";
import type { UserFromGetMe } from "grammy/types";

export type MeRoutesOptions = {
  getBotInfo: () => Promise<UserFromGetMe>;
};

export const meRoutes: FastifyPluginCallback<MeRoutesOptions> = (app, options, done) => {
  app.get("/me", () => options.getBotInfo());
  done();
};
