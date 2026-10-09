# BlinkShop

BlinkShop is a social-commerce checkout infrastructure MVP on Solana Devnet. It turns a shareable product link into a Privy embedded-wallet or Phantom-signed USDC payment, verifies that payment on the backend, and updates the order and inventory state.

The included merchant demo workspace is **Aria Studio**.

- **Live demo:** https://blinkshop.up.railway.app
- **Example Blink:** https://blinkshop.up.railway.app/blink/blk-001
- **Network:** Solana Devnet
- **Payment:** SPL USDC
- **Authentication:** Privy email OTP
- **Wallets:** Privy embedded Solana wallet for primary web checkout; Phantom for the fallback and Solana Actions

The app is publicly deployed as a single Railway instance. Its JSON store is persisted on a Railway Volume at `/data`. This is suitable for the hackathon demo, but it is not multi-instance-safe or production-ready.

## Problem

Social product discovery and checkout usually happen in separate places. Buyers leave the content, find the product again, and repeat checkout steps; merchants then have to reconcile payment and inventory across systems.

## Solution

BlinkShop gives each product a shareable checkout URL. The backend owns the product price, merchant destination, buyer-wallet binding, inventory reservation, and payment verification. A web buyer signs in with email and approves the exact Devnet USDC transfer with a Privy embedded wallet. Phantom remains available as a separate fallback.

## Why Solana Actions and Blinks?

Solana Actions provide a standard transaction response that compatible clients can render. Blinks make the Action reachable from a normal URL, while BlinkShop also provides `/blink/:id` as a browser checkout fallback. This keeps product discovery close to payment without trusting prices or destinations supplied by the browser.

## Architecture

```text
Merchant dashboard (Next.js client)
        │
        ├── Privy login + embedded Solana wallet
        │          │
        │          └── Verified access token + merchant DID authorization
        │
        ├── Protected products / orders API routes
        │          │
        │          └── Store + JSON persistence (local MVP)
        │
Buyer Blink ──> Privy access token ──> verified DID + embedded wallet
        │                                      │
        └── server-built USDC transfer <───────┘
                           │
                   Privy signs only
                           │
        BlinkShop validates every transaction field
                           │
       Devnet sponsor signs fee payer + backend broadcasts
                           │
                    Solana Devnet
                           │
           Independent backend payment verification
                           │
                Paid order + final stock

Solana Action / Phantom ──> existing unsigned transaction path ──┘
```

- UI and backend: Next.js 16 App Router with TypeScript.
- Authentication: Privy with server-verified access tokens.
- Wallets: Privy embedded Solana wallet for the primary browser checkout; Phantom remains the external-wallet and Solana Action path.
- Payment: SPL USDC on Solana Devnet.
- Local persistence: `data/store.json` through a small persistence adapter.
- Production persistence groundwork: Supabase schema and server-only REST adapter are included, but transactional store activation remains a deployment TODO.

## Buyer flow

1. Open `/blink/:productId`.
2. Select an in-stock variant and quantity.
3. Sign in with the configured Privy email method.
4. Wait for the embedded Solana wallet, then approve the exact USDC transfer.
5. BlinkShop validates the buyer-signed transaction, adds its dedicated Devnet fee-payer signature, and broadcasts it.
6. Wait for independent backend verification.
7. Review the confirmed order and Solana Explorer link.

The embedded wallet must already have a Devnet USDC associated token account
and enough Devnet USDC for the purchase. BlinkShop never sponsors ATA creation.
Use **Use Phantom instead** to exercise the original checkout path.

## Merchant flow

1. Sign in with Privy using an email one-time passcode.
2. The configured merchant DID receives access to the Aria Studio dashboard.
3. Create or edit a product and copy its generated Blink.
4. Follow payment status in the protected Orders view.
5. Open a paid transaction on Solana Explorer Devnet.

Privy creates a Solana embedded wallet during login and BlinkShop displays its
address. The buyer endpoint verifies the access token, loads that DID from
Privy server-side, selects its first embedded Solana wallet, and uses that
address for the order. A wallet address supplied by the browser is rejected.

## Payment verification

The client never chooses the final merchant destination or price. The server creates the transfer from stored product/order data and confirms the submitted signature by checking:

- the transaction succeeded;
- the USDC mint matches configuration;
- source and destination token accounts match buyer and merchant;
- buyer authority matches the order wallet;
- the exact token amount matches the order;
- token balance deltas match the transfer; and
- the transaction signature has not already been used by another order.

The first signature attached to an order is immutable. Retrying that same
signature is idempotent, while attempting to replace it returns `409` before
verification and leaves the original signature unchanged.

Production Action responses omit development-only blockhash, merchant-wallet, mint, and serialized-transaction metadata. Server errors do not expose secrets.

## Inventory and order lifecycle

- Creating a payment order reserves total and selected-variant inventory.
- A pending order expires after ten minutes.
- Expired orders become `cancelled` and release their reservation.
- A valid payment becomes `paid`; its signature is retained for audit and Explorer links.
- A pending or invalid submitted signature stays unbound; the order remains pending and reserved until valid confirmation or normal expiry.
- A server-side transaction-construction failure becomes `failed` and releases inventory.
- Paid orders retain `expiresAt` as the original reservation deadline/audit field; it no longer controls the paid state.
- A buyer wallet may have only one pending reservation per product until that order is paid, failed, or expires.

## Security checks

The deterministic automated suite covers:

- missing, invalid, and unauthorized Privy access tokens;
- protected merchant mutations and order reads;
- public product discovery and buyer checkout routes;
- variant overselling;
- sold-out variant purchases;
- duplicate transaction signatures;
- wrong payment amounts;
- wrong buyer wallets;
- authenticated buyer wallet binding and merchant-DID independence;
- missing buyer and merchant USDC token accounts; and
- sponsored instruction shape, including absence of ATA creation and `CloseAccount`.
- server-side fee-payer validation, buyer-signature verification, tamper rejection, fee caps, and broadcast safety.

Order-to-transaction memo binding (test 4F) is intentionally deferred. A future version should add the order ID with a Solana Memo instruction and verify that memo during confirmation.

## Technical proof

- SPL USDC transfer flows through Privy embedded wallets and the existing Phantom path.
- Backend verification of transaction success, mint, buyer, token accounts, merchant recipient, exact amount, and balance deltas.
- Server-controlled `pending` to `paid` transition only after verification.
- Privy access-token verification and merchant DID authorization on dashboard APIs.
- Automatic Privy Solana embedded-wallet provisioning for authenticated users.
- Total and selected-variant inventory reservation and final update.
- Immutable `txSignature` storage with duplicate-use protection.
- JSON persistence on a Railway persistent Volume at `/data` for the single deployed instance.
- GitHub CI for install, typecheck, automated tests, lint, and production build.
- 101 deterministic automated tests across buyer/merchant authorization, sponsored transaction construction and submission, inventory, order lifecycle, confirmation-state integrity, signature protection, and payment validation.

## Tech stack

- Next.js 16.3
- React 19
- TypeScript
- `@solana/web3.js`
- `@solana/spl-token`
- `@privy-io/react-auth`
- `@privy-io/node`
- Phantom
- Solana Devnet / Devnet USDC
- Local JSON persistence for development
- Supabase migration scaffold for production persistence

## Local setup

Requirements:

- Node.js version supported by Next.js 16
- npm
- Phantom configured for Solana Devnet when testing the fallback
- A Privy app with email login and Solana embedded wallets; TEE may remain enabled, but Privy fee sponsorship is not used
- A dedicated Devnet-only BlinkShop sponsor wallet with a small Devnet SOL balance
- Devnet SOL for Phantom fallback transaction fees
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
| `NEXT_PUBLIC_PRIVY_APP_ID` | Privy checkout/dashboard | Public Privy application ID used by `PrivyProvider`. |
| `PRIVY_APP_SECRET` | Privy checkout/dashboard | Server-only Privy application secret used to verify access tokens and load the authenticated user. Never prefix with `NEXT_PUBLIC_`. |
| `PRIVY_MERCHANT_USER_ID` | Merchant dashboard | Server-only Privy user DID authorized for the Aria Studio workspace. |
| `SOLANA_CLUSTER` | Yes | Must be exactly `devnet`; BlinkShop refuses server sponsorship on any other value. |
| `SOLANA_RPC_URL` | Yes | Solana Devnet RPC endpoint. |
| `SOLANA_USDC_MINT` | Yes | Devnet USDC SPL mint. |
| `MERCHANT_WALLET` | Yes | Public Solana address receiving USDC. Never use a private key. |
| `MERCHANT_ID` | Recommended | Merchant workspace identifier; defaults to Aria Studio's demo ID. |
| `SOLANA_SPONSOR_SECRET_KEY_BASE64` | Sponsored checkout | Server-only base64 encoding of a dedicated Devnet keypair's 64-byte secret key. Never expose with `NEXT_PUBLIC_`, log, or commit it. |
| `DATA_STORE` | Local only | Must currently be `json`; other values fail clearly instead of silently selecting an inactive adapter. |
| `DATA_DIR` | Optional | Directory containing `store.json`. Set to `/data` when using a Railway persistent volume; otherwise defaults to `<project>/data`. |
| `SUPABASE_URL` | Migration | Server-only Supabase project URL for the staged adapter. |
| `SUPABASE_SERVICE_ROLE_KEY` | Migration | Server-only service role key. Never expose it with `NEXT_PUBLIC_`. |

## Run locally

```bash
npm run dev
```

Open `http://localhost:3000`. Useful checks:

```bash
npx tsc --noEmit
npm test
npm run lint
npm run build
```

Main routes:

- Public: `GET /api/products`, `GET /api/products/:id`
- Merchant only: `POST /api/products`, `PATCH/DELETE /api/products/:id`
- Merchant only: `GET/POST /api/orders`, `GET /api/orders/:id`
- Authenticated Privy buyer: `POST /api/checkout/privy/:productId`
- Authenticated Privy buyer: `POST /api/checkout/privy/:productId/submit`
- `POST /api/orders/confirm`
- `GET/POST /api/actions/product/:id`
- `GET /actions.json`
- `GET /blink/:id`

## Devnet demo

The committed demo store contains three products priced from 0.15–0.30 USDC,
one sold-out size, and no historical orders. The first live payment therefore
appears as a clean new Paid order during the demo.

1. Start on the dashboard and show a product priced between 0.1 and 0.5 Devnet USDC.
2. Choose **Open Blink** and select an available variant and quantity.
3. Sign in with a non-merchant email and wait for the embedded Solana wallet.
4. Fund that wallet's existing ATA with Devnet USDC, but leave the wallet with 0 SOL.
5. Choose **Pay**; Privy signs without broadcasting, then BlinkShop validates, adds the Devnet fee-payer signature, broadcasts, and independently verifies the payment.
6. Show the payment receipt and Explorer link.
7. Return to **Orders** and confirm the order is Paid and stock decreased.
8. Separately choose **Use Phantom instead** to verify the fallback remains available.

Use Devnet assets only; they have no real-world value.

## Deployment

### Railway hackathon deployment

Railway can run the JSON-backed hackathon demo as a single service with a
persistent volume. This is suitable for controlled demo traffic, but it does
not add cross-instance locking. Merchant APIs require Privy authentication,
but the JSON store remains a single-workspace demo design.

1. Create a Railway service from this GitHub repository.
2. Set **Root Directory** to `/Frontend`.
3. Set **Build Command** to `npm run build`.
4. Set **Start Command** to `npm run start`.
5. Attach a persistent volume and mount it at `/data`.
6. Configure these variables:

   ```env
   DATA_STORE=json
   DATA_DIR=/data
   SOLANA_CLUSTER=devnet
   SOLANA_RPC_URL=<your-devnet-rpc-url>
   SOLANA_USDC_MINT=<your-devnet-usdc-mint>
   MERCHANT_WALLET=<your-public-merchant-wallet>
   MERCHANT_ID=merchant-aria-studio
   SOLANA_SPONSOR_SECRET_KEY_BASE64=<server-only-base64-secret>
   NEXT_PUBLIC_PRIVY_APP_ID=<your-privy-app-id>
   PRIVY_APP_SECRET=<your-server-only-privy-app-secret>
   PRIVY_MERCHANT_USER_ID=<did:privy:authorized-merchant-user>
   ```

7. Deploy once, then generate a public HTTPS domain in Railway.
8. Set `NEXT_PUBLIC_APP_URL` to that final Railway origin without a trailing
   slash, for example `https://blinkshop-production.up.railway.app`.
9. Redeploy after setting the final URL so Actions, callbacks, and Blink links
   all use the public HTTPS origin.
10. Verify `/actions.json`, `/api/actions/product/:id`, and `/blink/:id` on the
    deployed domain before running the Privy and Phantom Devnet demos.

Keep the service at one replica while using this JSON adapter. The mounted
volume makes restarts durable, but JSON file writes are not a distributed
database and should not be shared by multiple application replicas.

### Vercel showcase

The frontend can be deployed to Vercel as a read-only/public showcase over
HTTPS. Do not present the JSON-backed payment flow as production-durable.
Before deploying a public showcase:

1. Configure all required environment variables in the Vercel project.
2. Set `NEXT_PUBLIC_APP_URL` to the final HTTPS origin before building.
3. Confirm `/actions.json`, `/api/actions/product/:id`, and `/blink/:id` use that origin.
4. Replace local JSON persistence before relying on serverless durability or concurrent traffic.
5. Run the migration at `supabase/migrations/001_initial_schema.sql` in Supabase.
6. Complete transactional Supabase functions named for
   `reserve_inventory_and_create_order`,
   `expire_order_and_release_inventory`,
   `fail_order_and_release_inventory`, and `confirm_paid_order`, then wire the
   adapter into the business store.
7. Re-run the security and payment tests against the deployed Devnet app.

`data/store.json` is intentionally convenient for local demos, but Vercel's
filesystem is ephemeral and multiple function instances do not share its
in-memory state. Action POST may reserve an order on one instance while confirm
runs on another instance with different state. Do not treat the current JSON
adapter as production persistence.

Merchant mutations and order reads require a Privy bearer token. The backend
verifies the token with the Privy Node SDK and compares its user DID with
`PRIVY_MERCHANT_USER_ID`; browser-supplied wallet addresses or emails never
grant merchant access.

## Continuous integration

`.github/workflows/ci.yml` runs `npm ci`, TypeScript, Vitest, ESLint, and the
production build on pushes to `main` and on pull requests using Node.js 22.

## Known limitations

- Solana Devnet only.
- BlinkShop server sponsorship has not yet passed the live 0-SOL Devnet checkpoint; do not describe it as gasless until that succeeds.
- Buyer and merchant Devnet USDC ATAs must be created and funded outside BlinkShop before checkout.
- JSON persistence is limited to the single-instance Railway demo and local development; it is not multi-instance-safe.
- Supabase schema and persistence primitives are staged but not transactionally activated.
- Order ID memo binding/test 4F is deferred.
- Phantom fallback buyers still need Devnet SOL for their transaction fee.
- The hackathon safeguard limits pending orders per wallet/product and rejects fees above 20,000 lamports; production sponsorship also needs persistent rate limits, balance monitoring, alerts, managed key custody, caps, and circuit breakers.
- No affiliate system.
- Single configured Privy merchant DID; no multi-merchant workspace isolation.

## BlinkShop Devnet sponsor wallet

This implementation is for the Solana Devnet hackathon demo only. It does not
use Privy native fee sponsorship, the **Sponsor gas fees** toggle, client-side
sponsorship, prepaid sponsorship credits, or a Privy fee-payer wallet. TEE may
remain enabled for embedded-wallet signing; do not undo an existing migration.

Create a completely new keypair dedicated only to BlinkShop Devnet fees. Never
reuse the merchant wallet, a personal wallet, a Mainnet wallet, or a production
key. Keep only a small amount of free Devnet SOL in it. The secret belongs only
in local `.env.local` and the Railway server environment; never commit its JSON
file, send it through chat, expose it with `NEXT_PUBLIC_`, or log it.

```powershell
# Generate a dedicated keypair locally. Keep this file outside the repository.
$sponsorFile = Join-Path $HOME ".config/solana/blinkshop-devnet-sponsor.json"
solana-keygen new --outfile $sponsorFile

# Show only the public address.
$sponsorAddress = solana-keygen pubkey $sponsorFile
$sponsorAddress

# Encode the 64-byte secret locally without printing it, then paste it only
# into SOLANA_SPONSOR_SECRET_KEY_BASE64 in .env.local.
$secretBytes = [byte[]](Get-Content -Raw $sponsorFile | ConvertFrom-Json)
$secretBase64 = [Convert]::ToBase64String($secretBytes)
$secretBase64 | Set-Clipboard

# Obtain free Devnet SOL and verify the public balance.
solana airdrop 1 $sponsorAddress --url devnet
solana balance $sponsorAddress --url devnet
Remove-Variable secretBytes, secretBase64
```

Set `SOLANA_CLUSTER=devnet`, restart Next.js, and later add the same secret only
through Railway's server environment-variable UI. Pre-create both buyer and
merchant Devnet USDC ATAs. The server derives the sponsor public key from the
secret, verifies the buyer signature and exact `TransferChecked`, caps the
network fee, adds the fee-payer signature, and broadcasts with preflight.

BlinkShop server-side sponsored checkout implemented, but live 0-SOL Devnet E2E not yet verified.

## Future roadmap

- Transactional Supabase repository with row locking/RPC-based reservations.
- Solana Memo order binding and confirmation checks.
- Managed sponsor custody plus persistent sponsorship metering, alerts, and circuit breakers.
- Affiliate attribution.
- Multi-merchant workspace isolation.
- Additional wallet providers and richer operational analytics.
