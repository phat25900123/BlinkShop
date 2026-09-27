# BlinkShop

BlinkShop is a social-commerce checkout infrastructure MVP on Solana Devnet. It turns a shareable product link (a Blink) into a Phantom-signed USDC payment, verifies that payment on the backend, and updates the order and inventory state.

The included merchant demo workspace is **Aria Studio**.

## Problem

Social product discovery and checkout usually happen in separate places. Buyers leave the content, find the product again, and repeat checkout steps; merchants then have to reconcile payment and inventory across systems.

## Solution

BlinkShop gives each product a shareable checkout URL. The backend owns the product price, merchant destination, inventory reservation, and payment verification. The buyer only chooses an available variant and quantity, connects Phantom, and approves a Devnet USDC transfer.

## Why Solana Actions and Blinks?

Solana Actions provide a standard transaction response that compatible clients can render. Blinks make the Action reachable from a normal URL, while BlinkShop also provides `/blink/:id` as a browser checkout fallback. This keeps product discovery close to payment without trusting prices or destinations supplied by the browser.

## Architecture

```text
Merchant dashboard (Next.js client)
        │
        ├── Products / orders API routes
        │          │
        │          └── Store + JSON persistence (local MVP)
        │
Buyer Blink ──> Solana Action route ──> unsigned USDC transaction
        │                                  │
        └── Phantom signs and sends ───────┘
                           │
                    Solana Devnet
                           │
                 Backend verification
                           │
                Paid order + final stock
```

- UI and backend: Next.js 16 App Router with TypeScript.
- Wallet: Phantom browser provider.
- Payment: SPL USDC on Solana Devnet.
- Local persistence: `data/store.json` through a small persistence adapter.
- Production persistence groundwork: Supabase schema and server-only REST adapter are included, but transactional store activation remains a deployment TODO.

## Buyer flow

1. Open `/blink/:productId`.
2. Select an in-stock variant and quantity.
3. Connect Phantom on Solana Devnet.
4. Sign and send the USDC transaction.
5. Wait for backend verification.
6. Review the confirmed order and optional Solana Explorer link.

## Merchant flow

1. Create or edit a product in the dashboard.
2. Set a small USDC price, image, inventory, and optional variants.
3. Copy or open the generated Blink.
4. Follow payment status in Orders.
5. Open a paid transaction on Solana Explorer Devnet.

## Payment verification

The client never chooses the final merchant destination or price. The server creates the transfer from stored product/order data and confirms the submitted signature by checking:

- the transaction succeeded;
- the USDC mint matches configuration;
- source and destination token accounts match buyer and merchant;
- buyer authority matches the order wallet;
- the exact token amount matches the order;
- token balance deltas match the transfer; and
- the transaction signature has not already been used by another order.

Production Action responses omit development-only blockhash, merchant-wallet, mint, and serialized-transaction metadata. Server errors do not expose secrets.

## Inventory and order lifecycle

- Creating a payment order reserves total and selected-variant inventory.
- A pending order expires after ten minutes.
- Expired orders become `cancelled` and release their reservation.
- A valid payment becomes `paid`; its signature is retained for audit and Explorer links.
- An invalid payment becomes `failed` and releases inventory.
- Paid orders retain `expiresAt` as the original reservation deadline/audit field; it no longer controls the paid state.

## Security checks

The MVP has been exercised against:

- variant overselling;
- sold-out variant purchases;
- duplicate transaction signatures;
- wrong payment amounts; and
- wrong buyer wallets.

Order-to-transaction memo binding (test 4F) is intentionally deferred. A future version should add the order ID with a Solana Memo instruction and verify that memo during confirmation.

## Tech stack

- Next.js 16.3
- React 19
- TypeScript
- `@solana/web3.js`
- `@solana/spl-token`
- Phantom
- Solana Devnet / Devnet USDC
- Local JSON persistence for development
- Supabase migration scaffold for production persistence

## Local setup

Requirements:

- Node.js version supported by Next.js 16
- npm
- Phantom configured for Solana Devnet
- Devnet SOL for transaction fees
- Devnet USDC for the buyer wallet

Install dependencies:

```bash
npm install
```

Copy `.env.example` to `.env.local` and fill in the values. Do not commit `.env.local`.

## Environment variables

| Variable | Required | Purpose |
| --- | --- | --- |
| `NEXT_PUBLIC_APP_URL` | Yes | Public app origin. Use the production HTTPS origin after deployment. |
| `SOLANA_RPC_URL` | Yes | Solana Devnet RPC endpoint. |
| `SOLANA_USDC_MINT` | Yes | Devnet USDC SPL mint. |
| `MERCHANT_WALLET` | Yes | Public Solana address receiving USDC. Never use a private key. |
| `MERCHANT_ID` | Recommended | Merchant workspace identifier; defaults to Aria Studio's demo ID. |
| `DATA_STORE` | Local only | Currently `json`; documents the selected local adapter. |
| `SUPABASE_URL` | Migration | Server-only Supabase project URL for the staged adapter. |
| `SUPABASE_SERVICE_ROLE_KEY` | Migration | Server-only service role key. Never expose it with `NEXT_PUBLIC_`. |

## Run locally

```bash
npm run dev
```

Open `http://localhost:3000`. Useful checks:

```bash
npx tsc --noEmit
npm run lint
npm run build
```

Main routes:

- `GET/POST /api/products`
- `GET/PATCH/DELETE /api/products/:id`
- `GET/POST /api/orders`
- `GET /api/orders/:id`
- `POST /api/orders/confirm`
- `GET/POST /api/actions/product/:id`
- `GET /actions.json`
- `GET /blink/:id`

## Devnet demo

1. Start on the dashboard and show a product priced between 0.1 and 0.5 Devnet USDC.
2. Choose **Open Blink**.
3. Connect Phantom on Devnet.
4. Select an available variant and quantity.
5. Choose **Sign & pay**, then approve in Phantom.
6. Show the payment receipt and Explorer link.
7. Return to **Orders** and confirm the order is Paid.
8. Return to the product and show that total and variant stock decreased.

Use Devnet assets only; they have no real-world value.

## Deployment

The Next.js application can be deployed to Vercel over HTTPS. Before deploying:

1. Configure all required environment variables in the Vercel project.
2. Set `NEXT_PUBLIC_APP_URL` to the final HTTPS origin before building.
3. Confirm `/actions.json`, `/api/actions/product/:id`, and `/blink/:id` use that origin.
4. Replace local JSON persistence before relying on serverless durability or concurrent traffic.
5. Run the migration at `supabase/migrations/001_initial_schema.sql` in Supabase.
6. Complete transactional Supabase reserve/release/confirm functions and wire `SupabasePersistenceAdapter` into the business store.
7. Re-run the security and payment tests against the deployed Devnet app.

`data/store.json` is intentionally convenient for local demos, but Vercel's filesystem is ephemeral and multiple function instances do not share its in-memory state. Do not treat the current JSON adapter as production persistence.

## Known limitations

- Solana Devnet only.
- Phantom browser wallet dependency.
- JSON persistence is local-development only.
- Supabase schema and persistence primitives are staged but not transactionally activated.
- Order ID memo binding/test 4F is deferred.
- No gasless transactions.
- No affiliate system.
- No authentication or multi-merchant isolation in this hackathon MVP.

## Future roadmap

- Transactional Supabase repository with row locking/RPC-based reservations.
- Solana Memo order binding and confirmation checks.
- Gas sponsorship where the security model permits it.
- Affiliate attribution.
- Merchant authentication and workspace isolation.
- Additional wallet providers and richer operational analytics.
