# Architecture

BlinkShop is a Next.js application that combines a merchant workspace, buyer-facing Blink checkout, Solana Action endpoints, and server-side order state.

```text
Buyer / Blink UI
       ↓
Actions API creates transaction from server-owned order data
       ↓
Phantom signs and broadcasts transaction
       ↓
Solana records SPL USDC transfer
       ↓
Backend fetches and verifies transaction
       ↓
Verify buyer + mint + amount + merchant + balance deltas
       ↓
Order = Paid
       ↓
Reserved inventory becomes final
       ↓
Persistent JSON store
```

## Components

- `Frontend/app/`: merchant dashboard, Blink checkout, and Next.js API routes.
- `Frontend/lib/backend/store.ts`: product, order, reservation, expiry, and signature state transitions.
- `Frontend/lib/backend/solana.ts`: unsigned SPL USDC transaction construction and on-chain verification.
- `Frontend/lib/backend/store-persistence.ts`: JSON persistence. Railway mounts its persistent volume at `/data` through `DATA_DIR=/data`.
- `Frontend/app/api/actions/product/[id]/`: Solana Action metadata, transaction creation, and confirmation.

The deployed MVP runs one Railway instance. Its persistent volume survives service restarts, but the JSON store has no distributed locking and is not safe for multiple application replicas. Supabase schema and adapter groundwork exist but are intentionally inactive.

## Trust boundaries

The system trusts:

- Solana transaction data fetched by the backend from the configured RPC.
- Server-owned product, price, inventory, order, merchant, and payment configuration.

The system does **not** trust:

- Frontend-reported payment success.
- Frontend-reported amount or merchant destination.
- Arbitrary client order state.
- A transaction signature merely because the browser submitted it.

The client chooses a product variant and quantity and requests a transaction. The server creates the pending order, reserves inventory, calculates the amount, selects the configured merchant, and builds the transaction. Confirmation is a separate server-side verification step.

## On-chain and off-chain state

On-chain:

- Transaction and success/failure result.
- Buyer authority and source token account.
- Merchant destination token account.
- USDC mint and transferred amount.
- Token balance changes and transaction signature proof.

Off-chain:

- Products and variants.
- Inventory and pending reservations.
- Orders, expiry, and order status.
- Stored transaction signature.
- Merchant workspace data.

## Why the MVP has no custom program

Native Solana transactions and the SPL Token program provide the payment primitive required by this MVP: a buyer-authorized USDC transfer with independently verifiable transaction evidence. Product, order, and inventory rules remain server-side. A future design may add a custom program if requirements call for on-chain escrow, settlement rules, or other programmable guarantees; the MVP does not add one without a concrete need.
