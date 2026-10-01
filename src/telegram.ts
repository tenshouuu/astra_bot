import { Api } from "grammy";
import type { UserFromGetMe } from "grammy/types";

export function getBotInfo(botToken: string): Promise<UserFromGetMe> {
  return new Api(botToken).getMe();
}
