# Architecture

BlinkShop is a self-service checkout for social commerce on Solana Devnet.
Merchants sign in with email, create products and share them as Blinks. Buyers
pay in USDC from an embedded wallet. The USDC goes into an on-chain escrow, not
to the merchant, and is released once the order is delivered.

```text
Browser (Next.js pages)          BlinkShop server (Next.js route handlers)     Solana Devnet
───────────────────────          ─────────────────────────────────────────     ─────────────
Privy login + embedded wallet ─► verifies Privy token, resolves wallet
signs exactly what server built  builds tx, checks it, co-signs as sponsor ─► blinkshop_escrow
                                 reads escrow state back from chain       ◄─  order PDA + vault
                                 JSON store: products, orders, inventory
```

## Components

| Path | Role |
| --- | --- |
| `program/programs/blinkshop_escrow` | Anchor escrow program. `3T1GHqWTm8DhvwsoxoYRy5mRDoHgR4zCoEuf2nVxZcmw` |
| `Frontend/app/blink/[id]` | Public Blink checkout (Privy wallet, Phantom fallback). |
| `Frontend/app/order/[id]` | Buyer order tracking and buyer actions. |
| `Frontend/app/page.tsx`, `DashboardViews.tsx` | Merchant dashboard: products, orders, lifecycle actions. |
| `Frontend/app/api/checkout/privy/...` | Sponsored checkout: prepare and submit. |
| `Frontend/app/api/actions/product/...` | Solana Action (Blink) for external wallets. |
| `Frontend/app/api/orders/[id]/escrow/...` | Lifecycle: prepare, submit, sync, read. |
| `Frontend/lib/backend/escrow.ts` | PDA derivation, instruction encoding, account decoding. |
| `Frontend/lib/backend/sponsor-signing.ts` | The one place the sponsor key signs. |
| `Frontend/lib/backend/solana.ts` | On-chain payment and escrow state verification. |
| `Frontend/lib/backend/escrow-actions.ts` | Lifecycle rules, on-chain preconditions, sync. |
| `Frontend/lib/backend/store.ts` | Products, orders, inventory reservations. |

## Identity and tenant boundary

The verified Privy DID is the merchant identity. The merchant's payout wallet
is their Privy embedded Solana wallet, resolved on the server. A product stores
both. Each order copies the merchant DID and wallet from the product when it is
created, so later changes to the product cannot redirect an existing order.

Private product and order APIs filter by DID. The lifecycle routes accept a
caller as **merchant** only if their DID and embedded wallet both match the
order, and as **buyer** only if their embedded wallet matches the order's buyer.
Everyone else gets 404.

The server never trusts identity, wallet, amount, mint or fee payer sent by the
browser.

## Checkout flow

```text
1. prepare   POST /api/checkout/privy/{productId}
             server: check sponsor limits, reserve stock, create order,
                     build tx = [ exactly one create_order ]
                     fee payer = sponsor, rent payer = sponsor,
                     bind the message hash to the order
2. sign      browser: Privy embedded wallet signs as buyer (USDC authority)
3. co-sign   POST .../submit
             server: re-derive the expected instruction and compare it byte
                     for byte, check signers, hash, blockhash, fee cap,
                     order still valid, sponsor balance; sponsor signs LAST
4. submit    server broadcasts with preflight
5. sync      POST /api/orders/confirm
             server: verify the escrow PDA and vault on-chain, then mark the
                     order paid (escrow "Funded") and finalize stock
```

Payment is not recorded on submit. The order becomes paid only after step 5
reads the result back from the chain. See
[PAYMENT_VERIFICATION.md](./PAYMENT_VERIFICATION.md).

The Blink (Solana Action) path for external wallets such as Phantom builds the
same single `create_order`. The difference is that the buyer is both fee payer
and rent payer, and BlinkShop does not sign or broadcast it.

## Escrow lifecycle

On-chain accounts per order:

- **Order PDA**, seeds `["order", merchant, order_id]`, where `order_id` is
  `sha256` of the BlinkShop order id. It stores buyer, merchant, rent payer,
  mint, amount, status, `ship_by` and `release_after`.
- **Vault**, seeds `["vault", order]`. It is a USDC token account owned by the
  order PDA and holds exactly the order amount.

```text
            create_order (buyer)
                   │
                   ▼
   ┌──────────── Funded ─────────────┐
   │ mark_shipped (merchant)         │ refund (merchant any time,
   ▼                                 │  or buyer after ship_by)
Shipped ── refund (merchant) ────────┤
   │                                 ▼
   ├─ confirm_receipt (buyer) ──►  Released ── USDC to merchant
   └─ claim (after release_after) ─► Released
                                    Refunded ── USDC to buyer
```

| Instruction | Who signs | Requires | Effect |
| --- | --- | --- | --- |
| `create_order` | buyer (+ rent payer) | amount > 0, windows within 1 s to 30 days | Creates order PDA and vault, moves USDC into the vault, `ship_by = now + ship_window`. |
| `mark_shipped` | merchant | Funded | Shipped, `release_after = now + protection_window`. |
| `confirm_receipt` | buyer | Shipped | Pays merchant, closes vault, Released. |
| `claim` | anyone on-chain; BlinkShop sponsors only the merchant | Shipped, `now >= release_after` | Pays merchant, closes vault, Released. |
| `refund` | merchant (Funded/Shipped), or buyer (Funded and `now > ship_by`) | as listed | Pays buyer, closes vault, Refunded. |

The program checks every payout destination. `confirm_receipt` and `claim`
can only pay a token account owned by the merchant, and `refund` can only pay
one owned by the buyer. The vault's rent always goes back to the recorded rent
payer.

Lifecycle actions use the same pattern as checkout:

- `POST /api/orders/{id}/escrow/{ship|confirm-receipt|refund|claim}` prepares
  the transaction;
- the user's Privy wallet signs it;
- `POST .../submit` checks it, co-signs it and broadcasts it;
- `POST /api/orders/{id}/escrow` syncs the stored status from the chain.

The stored status only moves forward: paid → shipped → released or refunded.

Windows are configured on the server and written into each order when it is
created. The real values are a 7-day ship window and a 3-day protection window.
Demos use shorter windows (see the README).

## Fee payer and rent payer

| Flow | Fee payer | Rent payer (order PDA + vault) | Who broadcasts |
| --- | --- | --- | --- |
| Privy checkout | BlinkShop sponsor | BlinkShop sponsor | BlinkShop |
| Blink / Phantom checkout | buyer | buyer | buyer's wallet |
| Lifecycle actions (Privy) | BlinkShop sponsor | (no new accounts) | BlinkShop |

Approximate cost per sponsored order:

- rent for the order PDA, about 0.00235 SOL. It is never recovered because the
  program has no `close_order`, so the account remains as a receipt;
- rent for the vault, about 0.00204 SOL, returned to the rent payer at release
  or refund;
- network fees.

The total is about 0.0044 SOL per order. Sponsor limits bound this cost (see
PAYMENT_VERIFICATION).

The sponsor key is server-only and Devnet-only. It signs nothing except a
transaction with exactly one instruction of the escrow program, whose accounts
and data match what the server computed. It refuses any other program, any
extra instruction, ATA creation and account closures.

## Trust boundaries

Trusted:

- verified Privy token claims and the server-side lookup of the user's wallet;
- server-owned product and order state;
- server configuration: USDC mint, escrow program id, windows, sponsor key;
- on-chain state read by the server: order PDA owned by the program, vault balance.

Untrusted:

- anything identity- or money-related in a request body;
- a client's claim that a payment or action succeeded;
- a signed transaction, until it passes every check above.

## Persistence

Railway runs one replica with `DATA_STORE=json` and a persistent volume
(`DATA_DIR=/data`). The JSON store is synchronous, so reservations and
signature uniqueness are safe within one process. Running more than one
replica would break that. A Supabase adapter and migrations exist but are not
enabled.
