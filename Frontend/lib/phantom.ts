import { Transaction } from "@solana/web3.js";

export type SolanaWalletProvider = {
  isPhantom?: boolean;

  publicKey?: {
    toString(): string;
  };

  connect(): Promise<{
    publicKey?: {
      toString(): string;
    };
  }>;

  signTransaction(
    transaction: Transaction,
  ): Promise<Transaction>;

  sendRawTransaction?: (
    transaction: Uint8Array,
  ) => Promise<string>;

  signAndSendTransaction?: (
    transaction: Transaction,
  ) => Promise<{
    signature: string;
  }>;
};

type PhantomBrowserWindow = {
  phantom?: {
    solana?: SolanaWalletProvider;
  };

  solana?: SolanaWalletProvider;
};

export function getSolanaProvider():
  | SolanaWalletProvider
  | null {
  if (typeof window === "undefined") {
    return null;
  }

  const browserWindow =
    window as unknown as PhantomBrowserWindow;

  // Preferred current Phantom provider.
  const phantomProvider =
    browserWindow.phantom?.solana;

  if (phantomProvider?.isPhantom) {
    return phantomProvider;
  }

  // Legacy compatibility.
  if (browserWindow.solana) {
    return browserWindow.solana;
  }

  return null;
}