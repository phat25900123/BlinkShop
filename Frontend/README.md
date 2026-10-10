# BlinkShop

BlinkShop is a self-service social-commerce checkout MVP on Solana Devnet. Any
authenticated Privy user receives an isolated merchant workspace, creates
products and shareable Blinks, and receives Devnet USDC in that user's Privy
embedded Solana wallet.

- Live demo: https://blinkshop.up.railway.app
- Network: Solana Devnet
- Payment asset: SPL USDC
- Authentication: Privy email OTP
- Primary checkout: Privy embedded Solana wallet with a BlinkShop-sponsored fee
- Fallback: Phantom / Solana Actions

The deployed hackathon service uses one JSON file on a Railway persistent
volume. Merchant products and orders are logically isolated by verified Privy
DID, but this is not a production multi-tenant database.

## Self-service merchant model

```text
verified Privy access token
        │
        ├── user DID ───────────────> merchantId
        │
        └── Privy Node SDK
                 └── embedded Solana wallet ──> merchantWallet

Merchant A (DID A / wallet A)        Merchant B (DID B / wallet B)
        │                                    │
        ├── products A                       ├── products B
        ├── orders A only                    ├── orders B only
        └── USDC payout A                    └── USDC payout B
```

There is no merchant allowlist. Authentication establishes the current DID;
resource authorization then checks that DID against each product or order.
The browser cannot provide or change `merchantId` or `merchantWallet`.

## Architecture

```text
Merchant dashboard
  └── Privy login
       └── authenticated private products/orders + payout readiness

Public Blink
  └── product + variant + quantity
       └── Privy buyer DID resolves embedded buyer wallet server-side
            └── inventory reservation + immutable order payout snapshot
                 └── exact TransferChecked (buyer authority)
                      └── buyer signs only
                           └── server validates every field
                                └── BlinkShop sponsor signs fee payer last
                                     └── server broadcasts to Devnet
                                          └── independent confirmation
                                               └── Paid + inventory finalized

Phantom / Solana Action
  └── same product-owned payout destination and confirmation verifier
```

Key files:

- `app/api/products/`: public discovery plus authenticated `?mine=1` scope and
  ownership-protected mutations.
- `app/api/orders/`: merchant-isolated order list/detail and manual reservation.
- `app/api/merchant/me`: authenticated payout wallet and Devnet USDC ATA status.
- `lib/backend/store.ts`: reservation, expiry, inventory, signature, and tenant
  helpers.
- `lib/backend/sponsored-checkout.ts`: exact sponsored `TransferChecked` builder.
- `lib/backend/sponsored-submit.ts`: validation before sponsor signing/broadcast.
- `lib/backend/solana.ts`: Phantom transaction builder, payout readiness, and
  independent payment verifier.
- `lib/backend/store-persistence.ts`: JSON persistence and legacy normalization.

## Merchant flow

1. Sign in with any valid Privy email account.
2. Privy creates or loads the user's embedded Solana wallet.
3. BlinkShop opens that DID's merchant workspace without admin approval.
4. Create a product. The server binds the verified DID and embedded wallet.
5. Share `/blink/<product-id>`.
6. View only that merchant's products and orders.
7. Receive verified Devnet USDC in the product-owned payout wallet.

## Buyer flow

1. Open a public Blink and choose an available variant and quantity.
2. Sign in with Privy (the same account may also be a merchant).
3. BlinkShop resolves the buyer wallet from the verified DID and reserves stock.
4. The buyer signs the exact USDC transfer; the buyer does not need SOL.
5. BlinkShop validates the partial transaction, signs as fee payer, and
   broadcasts it.
6. The backend independently verifies the on-chain transfer before marking the
   order paid.

Phantom remains available as the external-wallet/Solana Action fallback; that
path pays the same product owner.

## Merchant payout readiness

Each new product pays its owner's Privy embedded Solana wallet. Before a new
merchant can receive checkout payments, that wallet needs an associated token
account for the configured Devnet USDC mint.

`GET /api/merchant/me` reports:

```json
{
  "merchantId": "did:privy:...",
  "payoutWallet": "...",
  "payoutUsdcAta": "...",
  "payoutReady": true
}
```

`payoutReady` does not require a positive balance. Receiving Devnet USDC from a
test faucet can create/fund the ATA. BlinkShop intentionally does not spend the
sponsor wallet on arbitrary merchant ATA creation.

## Payment verification and order lifecycle

An order snapshots `merchantId` and `merchantWallet` from its product when the
reservation is created. Confirmation uses that immutable payout expectation,
not a browser field or the old global merchant configuration.

The verifier checks transaction success, configured mint, exact buyer authority
and source ATA, exact order merchant destination ATA, exact base-unit amount,
and buyer/merchant balance deltas. It also preserves duplicate-signature,
signature-overwrite, pending-signature poisoning, and expiry protections.

- Pending reservations expire after ten minutes and release inventory.
- Construction failure marks the order failed and releases inventory once.
- Verified payment marks the order paid and retains consumed inventory.
- A paid order stores its immutable transaction signature.

## Security model

Server-owned values:

- merchant DID and payout wallet;
- buyer wallet for Privy checkout;
- product price and order amount;
- USDC mint and sponsor fee payer;
- order status, reservation, and confirmation result.

Client-selectable values are limited to product metadata during product
creation and product/variant/quantity during purchase. Sponsored submission
still requires exactly one SPL Token `TransferChecked`; ATA creation,
`CloseAccount`, System Program, Compute Budget, extra instructions, wrong
accounts, wrong amount, invalid buyer signature, expired blockhash, and fees
above the cap are rejected before the sponsor signs.

The deterministic suite currently contains 142 tests across 14 files, including
cross-merchant ownership, payout routing, legacy compatibility, readiness,
inventory, sponsored transaction validation, confirmation integrity, and
signature protection.

## Local setup

Requirements:

- Node.js supported by Next.js 16 and npm 10.x;
- a Privy app with email login and Solana embedded wallets;
- a dedicated Devnet-only sponsor keypair with a small Devnet SOL balance;
- a Solana Devnet RPC URL and Devnet USDC mint;
- Devnet USDC for buyer/merchant setup;
- Phantom on Devnet only when testing the fallback.

```bash
npm install
cp .env.example .env.local
npm run dev
```

Never commit `.env.local`, a seed phrase, sponsor keypair JSON, or RPC secret.

## Environment variables

| Variable | Required | Purpose |
| --- | --- | --- |
| `NEXT_PUBLIC_APP_URL` | Yes | Final public origin without trailing slash. |
| `NEXT_PUBLIC_PRIVY_APP_ID` | Yes | Public Privy app ID. |
| `PRIVY_APP_SECRET` | Yes | Server-only token verification/user lookup secret. |
| `SOLANA_CLUSTER` | Yes | Must be `devnet` for sponsorship. |
| `SOLANA_RPC_URL` | Yes | Solana Devnet RPC endpoint. |
| `SOLANA_USDC_MINT` | Yes | Server-owned Devnet USDC mint. |
| `SOLANA_SPONSOR_SECRET_KEY_BASE64` | Sponsored checkout | Server-only 64-byte Devnet fee-payer secret encoded as base64. |
| `DATA_STORE` | Yes | Must currently be `json`. |
| `DATA_DIR` | Railway | `/data` for the mounted persistent volume; local default is `<project>/data`. |
| `PRIVY_MERCHANT_USER_ID` | Legacy optional | Claims old `merchant-aria-studio` JSON records during normalization. It never authorizes access. |
| `MERCHANT_WALLET` | Legacy optional | Fills missing payout snapshots on old JSON records only. New products never use it. |

`MERCHANT_ID` is no longer used. Supabase variables remain staged only; the
Supabase adapter is not active.

## API scopes

- Public: `GET /api/products`, `GET /api/products/:id`, Action metadata and
  transaction routes, `/blink/:id`, and payment confirmation callbacks.
- Authenticated merchant: `GET /api/products?mine=1`, `POST /api/products`,
  `PATCH/DELETE /api/products/:id`, `GET/POST /api/orders`,
  `GET /api/orders/:id`, and `GET /api/merchant/me`.
- Authenticated Privy buyer: sponsored checkout prepare/submit routes.

Cross-merchant resource access returns `404` so one merchant cannot enumerate
another merchant's private records.

## Quality gates

```bash
npx --yes npm@10.9.4 ci
npx tsc --noEmit
npm test
npm run lint
npm run build
git diff --check
```

## Railway deployment

1. Create a Railway service from the repository.
2. Set Root Directory to `/Frontend`.
3. Use Build Command `npm run build` and Start Command `npm run start`.
4. Attach a persistent volume at `/data`.
5. Set `DATA_STORE=json`, `DATA_DIR=/data`, and every required core variable in
   the table above.
6. Generate the public HTTPS domain.
7. Set `NEXT_PUBLIC_APP_URL` to that final origin and redeploy.
8. Keep exactly one replica while JSON persistence is active.
9. Verify `/actions.json`, `/api/products`, a public Blink, Privy login, and the
   authenticated merchant profile before a live payment.

Legacy Railway data remains readable. Missing legacy `merchantWallet` values
are normalized from optional `MERCHANT_WALLET`; the old Aria ID can be claimed
by optional `PRIVY_MERCHANT_USER_ID`. Normalized state is persisted naturally
with the next store mutation. Neither variable affects new users or products.

## Known limitations

- Devnet only; assets have no real-world value.
- The merchant and buyer Devnet USDC ATAs must exist before sponsored checkout.
- JSON persistence and in-memory locking require one Railway replica. Logical
  DID isolation is not a substitute for a transactional multi-tenant database,
  row-level controls, audit logs, or distributed locking.
- Supabase schema/adapter groundwork is present but intentionally inactive.
- Order ID Memo binding (test 4F) is deferred.
- Phantom fallback buyers may need Devnet SOL for fees/ATA operations.
- Sponsor operations need stronger production custody, rate limits, metering,
  monitoring, and circuit breakers.
- No affiliate system, custom payout-wallet override, or production auth roles.

## Future roadmap

- Transactional database repository with tenant constraints and atomic inventory.
- Memo-based order-to-transaction binding.
- Managed sponsor custody and persistent abuse controls.
- Optional verified custom payout wallets.
- Affiliate attribution and richer merchant operations.
