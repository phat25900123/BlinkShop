# Demo walkthrough

A manual Devnet walkthrough of the escrow flow: buy, mark shipped, confirm
receipt, and claim a refund. Do not automate OTP entry or real Devnet
transactions.

Public deployment: https://blinkshop.up.railway.app. This walkthrough needs
the escrow build (`ESCROW_PROGRAM_ID` set) to be deployed there.

## Demo windows

The real windows are a 7-day ship window and a 3-day protection window:

```text
SHIP_WINDOW_SECONDS=604800
PROTECTION_WINDOW_SECONDS=259200
```

To show refund and claim live, shorten both before the demo and redeploy:

```text
SHIP_WINDOW_SECONDS=120
PROTECTION_WINDOW_SECONDS=120
```

Each order stores its windows on-chain when it is created (`create_order`), so
create the demo orders **after** the new values are live. Changing the windows
later does not affect existing orders. Restore the real values after the demo.

## Prerequisites

- one Railway replica with a persistent volume at `/data`;
- every required variable from the [root README](../README.md), including
  `ESCROW_PROGRAM_ID=3T1GHqWTm8DhvwsoxoYRy5mRDoHgR4zCoEuf2nVxZcmw`;
- the sponsor holds more Devnet SOL than `SPONSOR_MIN_BALANCE_LAMPORTS`. Each
  sponsored order costs about 0.0044 SOL in rent and fees;
- two Privy accounts: merchant A and buyer C;
- buyer C's embedded wallet holds Devnet USDC. It needs no SOL;
- merchant A's embedded wallet already has a Devnet USDC token account
  (Settings shows payout status). BlinkShop does not sponsor creating it.

## 1. Merchant creates a product

1. Sign in as merchant A.
2. Create a product and copy its Blink link (`/blink/<product-id>`).

## 2. Buyer pays into escrow

3. Open the Blink in another browser profile and sign in as buyer C.
4. Choose a variant and quantity and pay with the Privy wallet.
5. BlinkShop builds one `create_order` instruction. The buyer signs, the
   sponsor co-signs as fee and rent payer, and the server broadcasts it.
6. Wait for the receipt. The order becomes paid only after
   `/api/orders/confirm` has verified the order PDA and the vault on-chain.
7. Click **Track your order** to open `/order/<order-id>`. Status is
   **Funded** and the ship deadline counts down.

## 3. Ship and confirm receipt

8. As merchant A, open Orders. The order shows **Funded** with
   **Mark shipped** and **Refund** buttons. "In escrow" includes its amount.
9. Click **Mark shipped** and sign. The badge changes to **Shipped** and a
   protection-window countdown appears.
10. As buyer C, reload the tracking page and click **Confirm receipt**.
11. USDC goes from the vault to merchant A. Both views show **Released**, and
    the amount moves from "In escrow" to "Released revenue".
12. Open the transaction links. They point to Solana Explorer with
    `?cluster=devnet`.

## 4. Claim a refund (merchant never ships)

13. As buyer C, buy the product again. Do not ship it.
14. Wait until the ship window ends (120 seconds in the demo).
15. On the tracking page, **Claim refund** appears. Click it and sign.
16. USDC returns to buyer C and the order shows **Refunded**. Refunded orders
    are not counted in revenue.

## Optional checks

- **Merchant claim.** Ship an order, let the buyer do nothing, and wait for
  the protection window to end. The merchant then sees **Claim payout**.
- **Merchant refund.** **Refund** is available to the merchant on Funded and
  Shipped orders.
- **Phantom / Blink order.** Paying from an external wallet makes the buyer
  the fee and rent payer. The receipt says tracking, confirm receipt and
  refund are not available in BlinkShop for that order. The merchant can
  still ship, refund and claim.
- **Isolation.** A second merchant B does not see merchant A's products or
  orders. Another user opening `/order/<order-id>` gets "not found".

## Evidence if Devnet is unavailable

- `program/tests/blinkshop-escrow.ts`: the program's lifecycle and permission
  rules on a local validator.
- `Frontend/tests/escrow-actions.test.ts`: lifecycle prepare, submit and sync.
- `Frontend/tests/escrow-routes.test.ts`: who can act on an order.
- `Frontend/tests/escrow-payment-verification.test.ts`: on-chain payment
  verification.
- `Frontend/tests/sponsored-submit.test.ts`: checks before the sponsor signs.
- `Frontend/tests/escrow-ui.test.ts`: buttons, countdowns and revenue split.

See [SECURITY_TESTS.md](./SECURITY_TESTS.md) for the full list.

Devnet assets have no real-world value.
