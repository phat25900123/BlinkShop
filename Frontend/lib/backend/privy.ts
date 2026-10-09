import "server-only";

import {
  PrivyClient,
  isEmbeddedWalletLinkedAccount,
} from "@privy-io/node";

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

export async function getPrivyEmbeddedSolanaWallet(userId: string) {
  const user = await getPrivyClient().users()._get(userId);
  const wallet = user.linked_accounts
    .filter(isEmbeddedWalletLinkedAccount)
    .filter(
      (account) =>
        account.chain_type === "solana" &&
        account.connector_type === "embedded" &&
        account.wallet_client_type === "privy",
    )
    .sort((left, right) => left.wallet_index - right.wallet_index)[0];

  return wallet
    ? {
        address: wallet.address,
        walletId: wallet.id,
      }
    : null;
}
