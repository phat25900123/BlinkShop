# Judge demo

Public deployment: https://blinkshop.up.railway.app  
Example Blink: https://blinkshop.up.railway.app/blink/blk-001

## Prerequisites

- Phantom configured for Solana Devnet.
- Devnet SOL for the network fee.
- Devnet USDC in the buyer wallet.

Devnet assets have no real-world value.

## Reproducible walkthrough

1. Open the [merchant dashboard](https://blinkshop.up.railway.app) and note the current total and variant inventory for the example product.
2. Select **Open Blink**, or open the [example Blink](https://blinkshop.up.railway.app/blink/blk-001) directly.
3. Select an available variant. Point out that sold-out variants remain readable but cannot be purchased.
4. Choose a quantity within available inventory.
5. Connect Phantom and confirm it is using Devnet.
6. Choose **Sign & Pay** and approve the SPL USDC transaction in Phantom.
7. Wait for backend verification; do not treat wallet submission alone as payment success.
8. Show the payment confirmation and open the transaction on Solana Explorer.
9. Return to **Orders** and show the order in the `Paid` state with its stored `txSignature`.
10. Return to **Products** and show that total inventory and the selected variant decreased by the purchased quantity.
11. Briefly open Settings/navigation to demonstrate the rest of the merchant workspace remains available.

The pending reservation lasts ten minutes. If the transaction is abandoned, let the order expire before attempting to edit reserved inventory.

## Fallback proof

If a live wallet demo cannot be completed because Phantom, Devnet funding, or the public RPC is unavailable, inspect these artifacts instead:

- The order state and stored `txSignature` in the Orders view or `GET /api/orders`.
- `Frontend/app/api/actions/product/[id]/route.ts` for server-owned order creation and transaction construction.
- `Frontend/app/api/orders/confirm/route.ts` and `Frontend/app/api/actions/product/[id]/confirm/route.ts` for confirmation state transitions and signature protection.
- `Frontend/lib/backend/solana.ts` for buyer, token-account, mint, amount, transaction-status, and balance-delta validation.
- `Frontend/lib/backend/store.ts` for reservations, expiry, release, paid state, and signature immutability.
- [`SECURITY_TESTS.md`](./SECURITY_TESTS.md) and the deterministic `Frontend/tests/` suite.
