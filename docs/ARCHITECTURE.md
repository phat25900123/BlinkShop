# Architecture

BlinkShop combines self-service merchant workspaces, buyer-facing Blinks,
Solana Actions, sponsored Privy checkout, and server-side order/inventory state.

## Identity and tenant boundary

```text
Privy bearer token
      ↓ server verification
authenticated user DID ──────────────> merchantId
      ↓ Privy Node SDK
embedded Solana wallet ──────────────> merchantWallet

Merchant A                               Merchant B
DID A / wallet A                         DID B / wallet B
  ├─ products A                            ├─ products B
  ├─ orders A only                         ├─ orders B only
  └─ payout ATA A                          └─ payout ATA B
```

Authentication asks whether the token represents a valid Privy user.
Authorization separately checks whether that DID owns the requested product or
order. `PRIVY_MERCHANT_USER_ID` is not an allowlist; it is only an optional
legacy-data claim input.

Public buyers can discover products and purchase any active product. Private
product lists, order lists/details, and mutations are tenant-filtered.

## Payment flow

```text
Public product + buyer choice
       ↓
Server loads product owner and resolves authenticated buyer wallet
       ↓
Store reserves stock and snapshots merchantId + merchantWallet on order
       ↓
One exact USDC TransferChecked
  buyer ATA → order merchant ATA
  buyer = transfer authority
  BlinkShop sponsor = fee payer
       ↓
Privy buyer signs only
       ↓
Server validates message hash, signer, instruction, accounts, mint,
amount, decimals, blockhash, fee cap, and fresh order/product consistency
       ↓
Sponsor signs last; server broadcasts with preflight
       ↓
Independent confirmation verifies transaction + token balance deltas
       ↓
Order Paid; reserved inventory becomes final
```

The Phantom/Solana Action fallback builds a transaction for the same
`product.merchantWallet`. Confirmation uses `order.merchantWallet`, never a
browser-provided or global destination.

## Components

- `Frontend/app/`: dashboard, Blink checkout, and Route Handlers.
- `Frontend/app/api/merchant/me`: authenticated embedded payout wallet and ATA
  readiness.
- `Frontend/lib/backend/store.ts`: tenant queries plus product/order lifecycle.
- `Frontend/lib/backend/solana.ts`: Phantom transfer builder, payout readiness,
  and on-chain verifier.
- `Frontend/lib/backend/sponsored-checkout.ts`: narrow sponsored transaction.
- `Frontend/lib/backend/sponsored-submit.ts`: pre-sponsor validation/broadcast.
- `Frontend/lib/backend/store-persistence.ts`: JSON storage and legacy record
  normalization.

## Trust boundaries

Trusted:

- verified Privy token claims and server-side Privy user lookup;
- server-owned product/order state;
- configured Devnet mint and sponsor key;
- Solana transaction evidence fetched by the backend.

Untrusted:

- browser-supplied DID, merchant wallet, buyer wallet, mint, amount, or fee payer;
- client-reported payment success;
- a signature or partially signed transaction before full validation;
- arbitrary instructions in a sponsored transaction.

The sponsor key is server-only and Devnet-only. The sponsored path rejects ATA
creation, account closure, arbitrary programs, extra instructions, mismatched
accounts, invalid buyer signatures, expired blockhashes, and fees over the cap.

## Persistence boundary

Railway runs one replica with `DATA_STORE=json`, `DATA_DIR=/data`, and one
persistent volume. The JSON store is synchronous and provides tested logical
isolation in one process, but it has no distributed locks, database tenant
constraints, row-level policies, audit log, or safe multi-replica writes.

The inactive Supabase scaffold is not enabled. Production scaling requires a
transactional repository with atomic reservation/release/confirmation and
database-enforced tenant/signature constraints.

## Legacy compatibility

On load, records missing `merchantWallet` use optional legacy
`MERCHANT_WALLET`; `merchant-aria-studio` can map to optional
`PRIVY_MERCHANT_USER_ID`. Normalized values are written naturally on the next
store mutation. These variables never authorize users or route new products.

## Why there is no custom program

The SPL Token program supplies the payment primitive required by this MVP.
Product, reservation, and inventory rules remain server-side. A custom program
is deferred until escrow or programmable settlement is a concrete requirement.
