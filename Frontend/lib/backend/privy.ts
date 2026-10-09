import "server-only";

import { PrivyClient } from "@privy-io/node";

export class PrivyConfigurationError extends Error {
  constructor() {
    super("Privy server authentication is not configured");
    this.name = "PrivyConfigurationError";
  }
}

let client: PrivyClient | undefined;
let clientCredentials = "";

function getPrivyClient() {
  const appId = process.env.NEXT_PUBLIC_PRIVY_APP_ID?.trim();
  const appSecret = process.env.PRIVY_APP_SECRET?.trim();

  if (!appId || !appSecret) {
    throw new PrivyConfigurationError();
  }

  const credentials = `${appId}:${appSecret}`;
  if (!client || clientCredentials !== credentials) {
    client = new PrivyClient({ appId, appSecret });
    clientCredentials = credentials;
  }

  return client;
}

export async function verifyPrivyAccessToken(accessToken: string) {
  const claims = await getPrivyClient()
    .utils()
    .auth()
    .verifyAccessToken(accessToken);

  return { userId: claims.user_id };
}
