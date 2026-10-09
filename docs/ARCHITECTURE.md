# Architecture

BlinkShop is a Next.js application that combines a merchant workspace, buyer-facing Blink checkout, Solana Action endpoints, and server-side order state.

```text
Buyer / Blink UI
       ↓
Privy authentication binds the buyer's embedded Solana wallet
       ↓
Backend reserves inventory and creates one exact USDC TransferChecked
       ↓
Privy wallet signs only; the browser does not broadcast
       ↓
Backend validates the order, transaction, and buyer signature
       ↓
Dedicated BlinkShop Devnet fee payer signs and backend broadcasts
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

Phantom / Solana Action fallback
       ↓
Existing Action transaction + external-wallet broadcast
       ↓
Same independent backend payment verification
```

## Components

- `Frontend/app/`: merchant dashboard, Blink checkout, and Next.js API routes.
- `Frontend/lib/backend/store.ts`: product, order, reservation, expiry, and signature state transitions.
- `Frontend/lib/backend/solana.ts`: unsigned SPL USDC transaction construction and on-chain verification.
- `Frontend/lib/backend/sponsored-checkout.ts`: narrow Privy checkout transaction containing one `TransferChecked` with the BlinkShop sponsor as fee payer.
- `Frontend/lib/backend/sponsored-submit.ts`: buyer-signature, instruction, account, amount, fee, sponsor-signing, and Devnet broadcast boundary.
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
- A buyer-signed transaction until every instruction and signer is revalidated before the server sponsor signs it.

The client chooses a product variant and quantity and requests a transaction. The server creates the pending order, reserves inventory, calculates the amount, selects the configured merchant, and builds the transaction. Confirmation is a separate server-side verification step.

The dedicated sponsor key is server-only and Devnet-only. Privy signs the buyer authority but does not sponsor or broadcast. The server refuses extra instructions, ATA creation, account closure, arbitrary programs, mismatched accounts or amounts, invalid buyer signatures, expired blockhashes, and unexpectedly high fees before applying its fee-payer signature.

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
