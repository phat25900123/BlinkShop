# Judge demo

Public deployment: https://blinkshop.up.railway.app  
Example Blink: https://blinkshop.up.railway.app/blink/blk-001

## Prerequisites

- Privy email login and an embedded Solana wallet.
- A dedicated BlinkShop sponsor wallet funded with a small amount of free Devnet SOL.
- Devnet USDC in the buyer embedded wallet; the buyer may hold 0 SOL.
- Existing buyer and merchant Devnet USDC associated token accounts.

Devnet assets have no real-world value.

## Reproducible walkthrough

1. Open the [merchant dashboard](https://blinkshop.up.railway.app) and note the current total and variant inventory for the example product.
2. Select **Open Blink**, or open the [example Blink](https://blinkshop.up.railway.app/blink/blk-001) directly.
3. Select an available variant. Point out that sold-out variants remain readable but cannot be purchased.
4. Choose a quantity within available inventory.
5. Sign in with a non-merchant email and confirm the embedded wallet has USDC but 0 SOL.
6. Choose **Pay** and approve the exact USDC transaction in Privy.
7. Explain that Privy signs only: BlinkShop validates the partial transaction, adds its Devnet fee-payer signature, and broadcasts it.
8. Wait for independent backend verification; do not treat broadcast alone as payment success.
9. Show the confirmation and Explorer transaction, including the configured mint, exact amount, merchant destination, buyer authority, and BlinkShop fee payer.
10. Return to **Orders** and show the order in the `Paid` state with its stored `txSignature`.
11. Return to **Products** and show that total inventory and selected-variant inventory decreased correctly.
12. Use **Use Phantom instead** separately to demonstrate the unchanged external-wallet fallback.

The pending reservation lasts ten minutes. If the transaction is abandoned, let the order expire before attempting to edit reserved inventory.

## Fallback proof

If a live wallet demo cannot be completed because Privy, Devnet funding, or the RPC is unavailable, inspect these artifacts instead:

- The order state and stored `txSignature` in the Orders view or `GET /api/orders`.
- `Frontend/app/api/actions/product/[id]/route.ts` for server-owned order creation and transaction construction.
- `Frontend/app/api/orders/confirm/route.ts` and `Frontend/app/api/actions/product/[id]/confirm/route.ts` for confirmation state transitions and signature protection.
- `Frontend/lib/backend/solana.ts` for buyer, token-account, mint, amount, transaction-status, and balance-delta validation.
- `Frontend/lib/backend/sponsored-submit.ts` for validation before sponsor signing and broadcast.
- `Frontend/lib/backend/store.ts` for reservations, expiry, release, paid state, and signature immutability.
- [`SECURITY_TESTS.md`](./SECURITY_TESTS.md) and the deterministic `Frontend/tests/` suite.
