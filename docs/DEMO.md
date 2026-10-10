# Phase 3 manual checkpoint

Public deployment: https://blinkshop.up.railway.app

Do not automate OTP entry or a real Devnet transfer. Use three Privy accounts
and perform this checkpoint manually after deploying the uncommitted Phase 3
working tree.

## Prerequisites

- one Railway replica with a persistent volume at `/data`;
- required Privy, Devnet RPC, USDC mint, sponsor, and JSON environment values;
- sponsor funded with a small amount of free Devnet SOL;
- buyer C embedded wallet funded with Devnet USDC and optionally 0 SOL;
- merchant A and B embedded wallets each have the configured Devnet USDC ATA.

Receiving Devnet USDC once can create/fund a merchant ATA. A merchant does not
need SOL to receive USDC. BlinkShop intentionally does not sponsor ATA creation.

## Merchant A

1. Login with email A.
2. Confirm there is no Workspace access denied screen.
3. Confirm A's dashboard opens.
4. Open Settings and record merchant wallet A and payout status.
5. Create Product A.
6. Confirm Product A appears in A's private Products view.
7. Copy/open Blink A.

## Merchant B

8. Sign out A.
9. Login with email B.
10. Confirm B's dashboard opens automatically.
11. Confirm B does not see Product A in the private Products view.
12. Confirm B does not see A's Orders.
13. Open Settings and verify wallet B differs from wallet A.
14. Create Product B.
15. Confirm B sees Product B only.

## Buyer C purchases Product A

16. Open Blink A.
17. Login buyer C.
18. Confirm buyer C has Devnet USDC; the sponsored path may use 0 SOL.
19. Select a valid variant and quantity, then approve the exact transaction.
20. Confirm BlinkShop sponsor is fee payer.
21. Confirm the USDC destination is merchant wallet A, not B or a legacy global
    wallet.
22. Wait for `/api/orders/confirm` verification and Payment confirmed UI.
23. Open the Solana Explorer transaction.

## Isolation after payment

24. Sign in as merchant A again.
25. Confirm the Paid order appears in A's Orders view.
26. Confirm Product A total/variant inventory decreased.
27. Sign in as merchant B.
28. Confirm B still cannot see A's Paid order.
29. Optionally purchase Product B and verify the destination is wallet B.

## Fallback checks

- Open the Action/Phantom path for Product A and confirm its destination is
  wallet A.
- Sold-out variants stay disabled and over-quantity requests are rejected.
- If a merchant ATA is missing, Settings shows Setup required and checkout
  returns a controlled merchant-USDC-account error; it must never redirect to a
  legacy wallet.

## Evidence if Devnet is unavailable

- `Frontend/tests/merchant-auth.test.ts`: DID workspace/ownership isolation.
- `Frontend/tests/merchant-profile.test.ts`: payout profile/readiness boundary.
- `Frontend/tests/multi-merchant-solana.test.ts`: exact per-order payout verifier.
- `Frontend/tests/sponsored-checkout-transaction.test.ts`: product-owner
  destination and transaction shape.
- `Frontend/tests/sponsored-submit.test.ts`: pre-sponsor tenant/payment checks.
- `Frontend/tests/legacy-migration.test.ts`: Railway JSON compatibility.

Devnet assets have no real-world value. Keep the service at one replica until a
transactional persistence backend is active.
