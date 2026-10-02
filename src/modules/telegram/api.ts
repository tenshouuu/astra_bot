import { Api } from "grammy";
import type { UserFromGetMe } from "grammy/types";

const CACHE_TTL_MS = 60_000;

export function createGetBotInfo(
  botToken: string,
  api: Pick<Api, "getMe"> = new Api(botToken, { timeoutSeconds: 10 }),
  now: () => number = Date.now,
): () => Promise<UserFromGetMe> {
  let cached: UserFromGetMe | undefined;
  let expiresAt = 0;
  let pending: Promise<UserFromGetMe> | undefined;

  return () => {
    if (cached && now() < expiresAt) return Promise.resolve(cached);
    pending ??= Promise.resolve()
      .then(() => api.getMe())
      .catch(() => {
        throw new Error("Telegram bot information unavailable");
      })
      .then((info) => {
        cached = info;
        expiresAt = now() + CACHE_TTL_MS;
        return info;
      })
      .finally(() => {
        pending = undefined;
      });
    return pending;
  };
}
