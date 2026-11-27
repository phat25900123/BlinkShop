# Payment verification

The browser is never the source of truth. An order counts as paid only after
the server has read the escrow state back from Solana and it matches the
order. The same rule applies to every later status change.

## What the server expects

When an order is created, the server records:

- `merchantId` and `merchantWallet`, copied from the product;
- `buyerWallet`:
  - Privy checkout: the authenticated buyer's embedded wallet;
  - Blink checkout: the Action `account`;
- exact quantity, variant and USDC amount;
- `settlement`: `escrow` for every new order, `direct` for legacy orders paid
  before escrow;
- `sponsored`: `true` if BlinkShop pays fee and rent.

From these the server derives everything it checks on-chain:

- the order PDA (`["order", merchant, sha256(order id)]`);
- the vault PDA (`["vault", order]`);
- the configured USDC mint and escrow program id.

## Before the sponsor signs (Privy checkout and lifecycle)

The submit step rebuilds the expected instruction from server state and rejects
the transaction unless all of these hold:

1. Fee payer is the sponsor. The required signers are exactly the sponsor and
   the expected user, and the sponsor slot is still empty.
2. The user's signature is valid.
3. The transaction has exactly one instruction, from the escrow program, and
   it equals the expected instruction: same discriminator, every account (key,
   signer and writable flags) and every argument (order id, amount, windows).
   Extra instructions, other programs, ATA creation and account closures are
   all rejected.
4. The message hash equals the one bound to the order at prepare time. This
   blocks reuse and swapping.
5. The blockhash is still valid and the fee is within the cap (20,000 lamports).
6. The order is re-read and is still in the same state with the same binding,
   and is still at or above the minimum amount.
7. The sponsor's balance is at least `SPONSOR_MIN_BALANCE_LAMPORTS`. Below
   that, checkout returns `sponsor_balance_low` and releases the reserved stock.

Only then does the sponsor sign (last) and the server broadcast with preflight.
A successful broadcast still does not mark anything paid.

## Confirming payment from on-chain state

`POST /api/orders/confirm` (and the Blink confirm route) takes a transaction
signature and:

1. Rejects missing, expired, cancelled or failed orders.
2. Rejects a signature that is already attached to another order, or a
   different signature for an order that already has one.
3. Fetches the transaction at `confirmed` commitment. If it is not available
   yet, the order stays pending. A failed transaction is rejected.
4. Requires that the transaction touched the escrow program and this order's
   PDA.
5. Reads the order PDA and requires:
   - it is owned by the escrow program and has the right discriminator and size;
   - its stored order id, merchant, buyer, mint and amount (in base units)
     equal the server order;
   - its status is Funded or Shipped.
6. Reads the vault and requires it to be a token account of the configured
   mint, owned by the order PDA, holding exactly the order amount.
7. Re-reads the order, attaches the signature atomically and marks it paid.
   This also finalizes the reserved inventory.

For later actions, `POST /api/orders/{id}/escrow` repeats checks 5 and 6. Once
the order is Released or Refunded, the vault must be closed. The stored status
then moves forward to match the chain and never backwards.

Lifecycle prepare also mirrors the program's rules, so the sponsor never pays
for a transaction that would fail:

- shipping requires Funded;
- claim requires `now >= release_after`;
- a buyer refund requires `now > ship_by`;
- the destination token account must exist.

## Sponsor limits

Sponsoring an order costs rent, part of which is never recovered (see
ARCHITECTURE). These limits bound that cost. All are server configuration.

| Variable | Default | Enforced | Error |
| --- | --- | --- | --- |
| `MIN_ORDER_USDC` | `0.01` | at checkout, before stock is reserved, and again at submit | 409 `order_below_minimum` |
| `BUYER_MAX_PENDING_ORDERS` | `3` | per buyer wallet, unexpired pending orders | 429 `buyer_pending_limit` |
| `BUYER_MAX_ORDERS_PER_24H` | `30` | per buyer wallet, all orders in 24 h | 429 `buyer_daily_limit` |
| `SPONSOR_MIN_BALANCE_LAMPORTS` | `20000000` | sponsor SOL balance checked before signing | 503 `sponsor_balance_low`, stock released |
| `GLOBAL_MAX_SPONSORED_ORDERS_PER_24H` | `200` | all sponsored orders in 24 h, any status | 503 `sponsor_daily_cap` |

Blink / Phantom orders are paid by the buyer and do not count toward the global cap.

## Signature rules

| Situation | Result |
| --- | --- |
| Same signature, same paid order | Idempotent success. |
| Same signature, another order | Rejected. |
| Order already has signature A, request sends B | Rejected; A is kept. |
| Signature not yet visible or invalid | Not attached; order stays pending until confirmed or expired. |

## Known limitations

- **Single-replica JSON store.** Reservations, the signature uniqueness check
  and the sponsor limits are correct only within one process. Railway must run
  exactly one replica. The Supabase adapter is not enabled.
- **No `close_order`.** The program never closes the order PDA, so its rent
  (about 0.00235 SOL per sponsored order) is permanently spent. The sponsor
  limits exist to cap this.
- **No background sync.** The stored status changes only when a merchant or
  buyer loads the order or completes an action. A merchant can call `claim`
  directly on-chain, for example, and the store will not show it until someone
  opens that order.
- **No buyer actions for Blink / Phantom orders.** Those buyers have no Privy
  login, so BlinkShop cannot authenticate them for confirm receipt or refund.
  The merchant can still ship, refund and claim. The buyer's on-chain rights
  are unchanged and can be exercised outside BlinkShop.
- **Devnet only.** The sponsor key, USDC mint and program are Devnet
  deployments.
