# BlinkShop Frontend

This is the BlinkShop Next.js app. It contains the merchant dashboard, the
public Blink checkout (`/blink/<product-id>`), buyer order tracking
(`/order/<order-id>`) and the API routes. The routes build and co-sign
escrow transactions for the `blinkshop_escrow` program and verify them on-chain.

For setup, architecture and the escrow flow, see the [root README](../README.md).

## Quick start

```bash
cp .env.example .env.local   # fill in the values; never commit .env.local
npm install
npm run dev
```

Checks: `npm test`, `npm run lint`, `npx tsc --noEmit`, `npm run build`.

## Environment variables

`.env.example` lists every variable with comments. Secrets are server-only and
must never be committed.

| Variable | Required | Purpose |
| --- | --- | --- |
| `NEXT_PUBLIC_APP_URL` | Yes | Public origin without trailing slash. |
| `NEXT_PUBLIC_PRIVY_APP_ID` | Yes | Public Privy app ID. |
| `PRIVY_APP_SECRET` | Yes, secret | Server-side Privy token verification and user lookup. |
| `SOLANA_CLUSTER` | Yes | Must be `devnet`; the sponsor refuses any other cluster. |
| `SOLANA_RPC_URL` | Yes | Solana Devnet RPC endpoint. |
| `SOLANA_USDC_MINT` | Yes | Devnet USDC mint. |
| `ESCROW_PROGRAM_ID` | Yes | `3T1GHqWTm8DhvwsoxoYRy5mRDoHgR4zCoEuf2nVxZcmw`. Checkout fails closed without it. |
| `SOLANA_SPONSOR_SECRET_KEY_BASE64` | Yes, secret | Devnet-only sponsor (fee and rent payer), 64-byte secret key in base64. |
| `SHIP_WINDOW_SECONDS` | No | Time the merchant has to ship. Default `604800` (7 days), range 1 to 2592000. |
| `PROTECTION_WINDOW_SECONDS` | No | Buyer protection after shipping. Default `259200` (3 days), range 1 to 2592000. |
| `MIN_ORDER_USDC` | No | Smallest sponsored order. Default `0.01`. |
| `BUYER_MAX_PENDING_ORDERS` | No | Open pending checkouts per buyer wallet. Default `3`. |
| `BUYER_MAX_ORDERS_PER_24H` | No | Checkouts per buyer wallet per 24 hours. Default `30`. |
| `SPONSOR_MIN_BALANCE_LAMPORTS` | No | Sponsor stops signing below this balance. Default `20000000`. |
| `GLOBAL_MAX_SPONSORED_ORDERS_PER_24H` | No | Sponsored checkouts per 24 hours, all buyers. Default `200`. |
| `DATA_STORE` | Yes | Must be `json`. |
| `DATA_DIR` | Railway | `/data` on the mounted volume. Defaults to `<project>/data` locally. |
| `PRIVY_MERCHANT_USER_ID` | Legacy, optional | Claims old `merchant-aria-studio` JSON records during normalization. It never authorizes access. |
| `MERCHANT_WALLET` | Legacy, optional | Fills missing payout snapshots on old JSON records only. New products never use it. |

The `SUPABASE_*` variables are reserved for the Supabase adapter, which is not
active.

## Code map

| Path | Role |
| --- | --- |
| `app/page.tsx`, `app/DashboardViews.tsx` | Merchant dashboard, orders table, lifecycle buttons. |
| `app/blink/[id]/` | Public Blink checkout (Privy wallet, Phantom fallback). |
| `app/order/[id]/` | Buyer order tracking, confirm receipt, claim refund. |
| `app/api/checkout/privy/[productId]/` | Sponsored checkout: prepare and `submit`. |
| `app/api/actions/product/[id]/` | Solana Action (Blink) for external wallets, and its `confirm`. |
| `app/api/orders/confirm/` | Marks an order paid after on-chain escrow verification. |
| `app/api/orders/[id]/escrow/` | Lifecycle: read and sync (`GET`/`POST`), `[action]` prepare, `[action]/submit`. |
| `lib/backend/escrow.ts` | PDA derivation, instruction encoding, account decoding. |
| `lib/backend/sponsored-checkout.ts` | Builds the single `create_order` instruction. |
| `lib/backend/sponsored-submit.ts`, `sponsor-signing.ts` | Checks before the sponsor signs, then broadcasts. |
| `lib/backend/escrow-actions.ts` | Lifecycle rules, on-chain preconditions, status sync. |
| `lib/backend/solana.ts` | On-chain payment and escrow state verification. |
| `lib/backend/store.ts` | Products, orders, inventory reservations, signature protection. |
| `lib/escrow-ui.ts` | Client-side badges, available actions, countdowns, revenue split. |

## Deployment

Railway: Root Directory `/Frontend`, build `npm run build`, start
`npm run start`, a persistent volume at `/data`, `DATA_STORE=json`,
`DATA_DIR=/data` and **exactly one replica**. The JSON store and its in-process
locking are not safe with more than one replica.
