import type { Metadata } from "next";
import type { ReactNode } from "react";
import { BlinkShopPrivyProvider } from "@/components/providers/PrivyProvider";
import "./globals.css";

export const metadata: Metadata = {
  title: "BlinkShop | Social commerce, settled on Solana",
  description: "Turn every social post into an instant, onchain checkout.",
  icons: {
    icon: [{ url: "/blinkshop-logo.png", type: "image/png" }],
    apple: "/blinkshop-logo.png",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: ReactNode;
}>) {
  return (
    <html lang="en" className="h-full antialiased">
      <body className="min-h-full flex flex-col">
        <BlinkShopPrivyProvider>{children}</BlinkShopPrivyProvider>
      </body>
    </html>
  );
}
