"use client";

import {
  createContext,
  useContext,
  useMemo,
  type ReactNode,
} from "react";
import {
  PrivyProvider as PrivyReactProvider,
  usePrivy,
} from "@privy-io/react-auth";
import {
  createSolanaRpc,
  createSolanaRpcSubscriptions,
} from "@solana/kit";

type BlinkShopAuth = {
  configured: boolean;
  ready: boolean;
  authenticated: boolean;
  userId: string | null;
  displayName: string;
  embeddedSolanaWallet: string | null;
  getAccessToken: () => Promise<string | null>;
  login: () => void;
  logout: () => Promise<void>;
};

const unavailableAuth: BlinkShopAuth = {
  configured: false,
  ready: true,
  authenticated: false,
  userId: null,
  displayName: "",
  embeddedSolanaWallet: null,
  getAccessToken: async () => null,
  login: () => undefined,
  logout: async () => undefined,
};

const AuthContext = createContext<BlinkShopAuth>(unavailableAuth);

function PrivyAuthBridge({ children }: { children: ReactNode }) {
  const {
    ready,
    authenticated,
    user,
    login,
    logout,
    getAccessToken,
  } = usePrivy();

  const value = useMemo<BlinkShopAuth>(() => {
    const embeddedSolanaWallet = user?.linkedAccounts
      .filter(
        (account) =>
          account.type === "wallet" &&
          account.chainType === "solana" &&
          (account.walletClientType === "privy" ||
            account.walletClientType === "privy-v2"),
      )
      .sort(
        (left, right) =>
          ("walletIndex" in left ? left.walletIndex ?? 0 : 0) -
          ("walletIndex" in right ? right.walletIndex ?? 0 : 0),
      )[0];

    return {
      configured: true,
      ready,
      authenticated,
      userId: user?.id ?? null,
      displayName:
        user?.email?.address ||
        user?.google?.email ||
        user?.id ||
        "Privy user",
      embeddedSolanaWallet:
        embeddedSolanaWallet && "address" in embeddedSolanaWallet
          ? embeddedSolanaWallet.address
          : null,
      getAccessToken,
      login,
      logout,
    };
  }, [authenticated, getAccessToken, login, logout, ready, user]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function BlinkShopPrivyProvider({ children }: { children: ReactNode }) {
  const appId = process.env.NEXT_PUBLIC_PRIVY_APP_ID?.trim();

  if (!appId) {
    return (
      <AuthContext.Provider value={unavailableAuth}>
        {children}
      </AuthContext.Provider>
    );
  }

  return (
    <PrivyReactProvider
      appId={appId}
      config={{
        loginMethods: ["email"],
        solana: {
          rpcs: {
            "solana:devnet": {
              rpc: createSolanaRpc("https://api.devnet.solana.com"),
              rpcSubscriptions: createSolanaRpcSubscriptions(
                "wss://api.devnet.solana.com",
              ),
            },
          },
        },
        embeddedWallets: {
          solana: {
            createOnLogin: "all-users",
          },
        },
        appearance: {
          theme: "light",
          accentColor: "#20211f",
          landingHeader: "Sign in to BlinkShop",
          loginMessage: "Continue checkout or access the Aria Studio workspace.",
        },
      }}
    >
      <PrivyAuthBridge>{children}</PrivyAuthBridge>
    </PrivyReactProvider>
  );
}

export function useBlinkShopAuth() {
  return useContext(AuthContext);
}
