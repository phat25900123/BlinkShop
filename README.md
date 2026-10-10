# BlinkShop

Self-service, social-native USDC checkout infrastructure on Solana.

- **Live demo:** https://blinkshop.up.railway.app
- **Example Blink:** https://blinkshop.up.railway.app/blink/blk-001
- **Network:** Solana Devnet
- **Payment:** SPL USDC
- **Authentication:** Privy email login
- **Wallets:** Privy embedded Solana wallet; Phantom Action fallback
- **Application:** [`Frontend/`](./Frontend)

## Core flow

```text
Any authenticated Privy merchant
      ↓
Own products + own orders + embedded payout wallet
      ↓
Shareable Blink → buyer chooses variant + quantity
      ↓
Privy buyer signs exact SPL USDC transfer
      ↓
BlinkShop sponsor pays the Devnet fee and broadcasts
      ↓
Backend verifies buyer + mint + owner payout + exact amount
      ↓
Order = Paid → inventory finalized
```

The verified Privy DID is the merchant identity. New products bind the
merchant's server-resolved embedded Solana wallet, orders snapshot that payout,
and private product/order APIs filter by DID. Browser-supplied identity, wallet,
amount, mint, or fee-payer values are never trusted.

The Railway hackathon deployment uses one JSON file on a persistent volume and
must stay at one replica. It demonstrates logical merchant isolation, not
production multi-tenant persistence.

## Documentation

- [Setup, environment, APIs, and deployment](./Frontend/README.md)
- [Architecture and trust boundaries](./docs/ARCHITECTURE.md)
- [Payment verification](./docs/PAYMENT_VERIFICATION.md)
- [Security tests](./docs/SECURITY_TESTS.md)
- [Merchant A / Merchant B / Buyer C demo](./docs/DEMO.md)
