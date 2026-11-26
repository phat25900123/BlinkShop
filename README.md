# BlinkShop

Escrow-protected USDC checkout for social commerce on Solana.

Merchants sign in with email, create a product and share it as a Blink. Buyers
pay in USDC from an embedded wallet, without needing SOL. The payment sits in
an on-chain escrow until the buyer confirms delivery or the protection window
ends. If the merchant never ships, the buyer gets a refund.

- **Live demo:** TODO
- **Demo video:** TODO
- **Network:** Solana Devnet
- **Escrow program ID:** `3T1GHqWTm8DhvwsoxoYRy5mRDoHgR4zCoEuf2nVxZcmw`
  ([view on Solana Explorer](https://explorer.solana.com/address/3T1GHqWTm8DhvwsoxoYRy5mRDoHgR4zCoEuf2nVxZcmw?cluster=devnet))
- **Payment:** SPL USDC (Devnet)
- **Auth and wallets:** Privy email login with an embedded Solana wallet;
  Phantom through a Solana Action (Blink)

## How it works

```text
Buyer opens Blink → server builds one create_order instruction
      → buyer signs with Privy wallet → BlinkShop sponsor co-signs (pays fee + rent)
      → USDC locked in the order's escrow vault → server verifies the PDA and vault on-chain
      → merchant marks shipped → buyer confirms receipt (or protection window ends)
      → USDC released to merchant           (or refunded to buyer)
```

The server never trusts identity, wallet, amount or mint values sent by the
browser. The sponsor key co-signs only a transaction that contains exactly the
escrow instruction the server computed. Details:

- [Architecture: checkout flow, escrow lifecycle, fee and rent payers](./docs/ARCHITECTURE.md)
- [Payment verification, sponsor limits and known limitations](./docs/PAYMENT_VERIFICATION.md)
- [Security tests](./docs/SECURITY_TESTS.md)
- [Demo walkthrough](./docs/DEMO.md)

## Repository layout

| Path | Contents |
| --- | --- |
| [`Frontend/`](./Frontend) | Next.js app: dashboard, Blink checkout, order tracking, API routes, tests |
| [`program/`](./program) | Anchor escrow program `blinkshop_escrow` and its TypeScript tests |
| [`docs/`](./docs) | Architecture, verification, security and demo notes |

## Run the app

Requires Node.js 20+.

```bash
cd Frontend
cp .env.example .env.local   # then fill in the values (see below)
npm install
npm run dev                  # http://localhost:3000
```

Checks: `npm test`, `npm run lint`, `npx tsc --noEmit`.

### Environment variables

Set these in `Frontend/.env.local` locally, or in Railway. Never commit real
values. `Frontend/.env.example` lists the defaults for the non-secret settings.

| Variable | Required | Purpose |
| --- | --- | --- |
| `NEXT_PUBLIC_APP_URL` | yes | Public base URL, used in Blink metadata |
| `NEXT_PUBLIC_PRIVY_APP_ID` | yes | Privy app id (public) |
| `PRIVY_APP_SECRET` | yes, **secret** | Server-side Privy token verification |
| `SOLANA_CLUSTER` | yes | Must be `devnet` |
| `SOLANA_RPC_URL` | yes | Devnet RPC endpoint |
| `SOLANA_USDC_MINT` | yes | Devnet USDC mint |
| `ESCROW_PROGRAM_ID` | yes | The escrow program ID above |
| `SOLANA_SPONSOR_SECRET_KEY_BASE64` | yes, **secret** | Devnet sponsor keypair (fee and rent payer) |
| `SHIP_WINDOW_SECONDS` | no | Time the merchant has to ship |
| `PROTECTION_WINDOW_SECONDS` | no | Buyer protection after shipping |
| `MIN_ORDER_USDC` | no | Smallest sponsored order |
| `BUYER_MAX_PENDING_ORDERS` | no | Unpaid checkouts per buyer |
| `BUYER_MAX_ORDERS_PER_24H` | no | Orders per buyer per day |
| `SPONSOR_MIN_BALANCE_LAMPORTS` | no | Sponsor stops signing below this SOL balance |
| `GLOBAL_MAX_SPONSORED_ORDERS_PER_24H` | no | Sponsored orders per day, all buyers |
| `DATA_STORE` | yes | `json` |
| `DATA_DIR` | yes in production | Directory for the JSON store (a persistent volume) |

`PRIVY_MERCHANT_USER_ID`, `MERCHANT_WALLET` and the `SUPABASE_*` variables are
optional. They are used only for legacy data or the inactive Supabase adapter.

### Demo windows vs. real windows

The real configuration gives the merchant **7 days** to ship and the buyer
**3 days** of protection after shipping. For a live demo, set both windows to a
couple of minutes so that refund and claim can be shown on stage. Each order
keeps the windows it was created with, so changing them later affects only new
orders.

## Build and test the program

Pinned toolchain: Rust 1.79.0 (`program/rust-toolchain.toml`), Solana CLI
1.18.17, Anchor 0.30.1. Do not run `cargo update`, because `Cargo.lock` is
pinned on purpose.

```bash
cd program
npm install
anchor keys sync            # fresh clone only: matches declare_id to your local program keypair
anchor build --no-idl
python3 scripts/gen_idl.py  # writes the IDL and types (anchor's IDL build fails on this toolchain)
anchor test --skip-build
```

The program deployed on Devnet is `3T1GHqWTm8DhvwsoxoYRy5mRDoHgR4zCoEuf2nVxZcmw`.
On a fresh clone, `anchor keys sync` changes `declare_id!` to the address of
your own local keypair, for local testing only. Do not commit that change.

## Deployment notes

The hackathon deployment runs on Railway with **one replica**, `DATA_STORE=json`
and a persistent volume mounted at `DATA_DIR`. The JSON store is not safe with
more than one replica.

## License

[MIT](./LICENSE)
