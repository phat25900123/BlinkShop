# BlinkShop

Social-native checkout infrastructure on Solana.

- **Live Demo:** https://blinkshop.up.railway.app
- **Example Blink:** https://blinkshop.up.railway.app/blink/blk-001
- **Network:** Solana Devnet
- **Payment:** SPL USDC
- **Wallet:** Phantom
- **Repository app:** [`Frontend/`](./Frontend)

## Core flow

```text
Social content
      ↓
     Blink
      ↓
Variant + quantity
      ↓
    Phantom
      ↓
 SPL USDC transaction
      ↓
  Solana Devnet
      ↓
Backend verification
      ↓
  Order = Paid
      ↓
Inventory updated
```

The backend reserves inventory before creating a payment transaction. It marks an order paid only after independently verifying the successful on-chain transfer, expected buyer, USDC mint, merchant recipient, exact amount, token balance deltas, and transaction-signature uniqueness.

## Technical documentation

- [Application setup and operation](./Frontend/README.md)
- [Architecture and trust boundaries](./docs/ARCHITECTURE.md)
- [Payment verification](./docs/PAYMENT_VERIFICATION.md)
- [Security tests](./docs/SECURITY_TESTS.md)
- [Judge demo script](./docs/DEMO.md)
