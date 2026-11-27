# Security tests

Two deterministic suites cover the security rules. Neither needs Phantom, a
public RPC, Railway or a funded wallet.

- **Frontend** (`Frontend/tests/`, `npm test`): uses an in-memory store,
  mocked Privy and RPC dependencies, and transaction and account fixtures.
  354 tests in 20 files pass on `feature/escrow-checkout`.
- **Program** (`program/tests/blinkshop-escrow.ts`, `anchor test`): runs
  against a local validator. 9 tests pass.

Each row below names the test file that checks it.

## Escrow program (on-chain)

| Check | Expected result | Evidence |
| --- | --- | --- |
| Happy path | create, ship and confirm pay the merchant. | `program/tests/blinkshop-escrow.ts` |
| Confirm before shipping | The buyer cannot confirm a Funded order. | same |
| Stranger actions | A third party can neither mark shipped nor confirm. | same |
| Payout destination | Funds cannot be sent to a wrong destination. | same |
| Merchant refund | The merchant can refund (cancel) an order. | same |
| Buyer reclaim | The buyer can reclaim only after the ship window has passed. | same |
| Merchant claim | The merchant can claim only after the protection window has passed. | same |
| Blink flow | The buyer can be fee payer and rent payer with one signature. | same |
| Argument bounds | A zero amount and an out-of-range window are rejected. | same |

## Instruction encoding and configuration

| Check | Expected result | Evidence |
| --- | --- | --- |
| Discriminator | `create_order` matches the Anchor derivation and the IDL. | `escrow-encoding.test.ts` |
| PDAs and order id | The order id is `sha256` of the BlinkShop id. The order and vault PDAs follow the program seeds. | `escrow-encoding.test.ts` |
| Strict decoding | Wrong discriminator or length, and out-of-range values, are rejected. The account order matches `CreateOrder`. | `escrow-encoding.test.ts` |
| Escrow config | A missing program id fails closed. Windows default to 604800 and 259200 seconds. | `escrow-config.test.ts` |
| Sponsor limit config | Documented defaults apply. `MIN_ORDER_USDC` is read exactly in base units. | `escrow-config.test.ts` |
| Sponsor key config | A missing, malformed or non-64-byte secret is rejected. Only Devnet is accepted. | `solana-sponsor.test.ts` |

## Sponsored checkout (Privy)

| Check | Expected result | Evidence |
| --- | --- | --- |
| Authentication | No token or an invalid token gets 401, and no stock is reserved. | `privy-buyer-checkout.test.ts`, `privy-buyer-submit.test.ts` |
| Client-owned fields | A browser-supplied buyer wallet, merchant wallet or payment field is rejected without changing state. | `privy-buyer-checkout.test.ts`, `privy-buyer-submit.test.ts` |
| Transaction shape | Exactly one `create_order`, with no ATA, close or transfer instruction, and the configured windows. | `sponsored-checkout-transaction.test.ts` |
| Merchant routing | Each product pays its own merchant, never the legacy global wallet. | `sponsored-checkout-transaction.test.ts`, `privy-buyer-checkout.test.ts` |
| Missing setup | A missing program id, sponsor config or buyer/merchant USDC account gives a controlled error and releases stock. | `privy-buyer-checkout.test.ts`, `sponsored-checkout-transaction.test.ts` |
| Sponsor limits | The minimum order, 3 pending per wallet, 30 per wallet per 24 h, and the global 24 h cap are enforced. Other wallets' orders are not counted. | `privy-buyer-checkout.test.ts` |
| Signing boundary | Rejected before the sponsor signs: tampered fee payer, buyer or blockhash; missing or invalid buyer signature; a client-provided sponsor signature. | `sponsored-submit.test.ts` |
| Exact instruction | Rejected: swapped, reordered, extra or writable-flipped accounts; appended data; a second instruction; Compute Budget; another program; the old direct `TransferChecked`. | `sponsored-submit.test.ts` |
| Order state at submit | Rejected: another buyer's order, an expired order, a route product mismatch, a changed merchant snapshot, an order below the minimum. | `sponsored-submit.test.ts`, `privy-buyer-submit.test.ts` |
| Fee and blockhash | An expired blockhash and a fee above the cap are rejected. | `sponsored-submit.test.ts` |
| Sponsor balance | Signing is refused below the threshold and allowed at it. If the balance is unreadable, signing fails closed and the order stays pending. | `sponsored-submit.test.ts`, `privy-buyer-submit.test.ts` |
| Broadcast safety | Verified bytes are broadcast. An ambiguous broadcast failure leaves the order unchanged. A replay does not reserve again or mark paid. | `sponsored-submit.test.ts`, `privy-buyer-submit.test.ts` |
| Blink (Phantom) transaction | The buyer is fee payer, rent payer and sole signer. No ATA creation is added. | `sponsored-checkout-transaction.test.ts` |

## Payment verification

| Check | Expected result | Evidence |
| --- | --- | --- |
| Escrow state | Paid requires a Funded or Shipped order PDA owned by the program, and a vault holding exactly the amount. | `escrow-payment-verification.test.ts` |
| Account fields | Wrong discriminator, length, order id, merchant, buyer, mint, amount (under or over) or status is rejected. | `escrow-payment-verification.test.ts` |
| Vault | A vault that is missing, for another mint, controlled by someone else, short or empty is rejected. | `escrow-payment-verification.test.ts` |
| Transaction evidence | Not yet visible means pending. A failed transaction, or one that does not touch the order PDA or program, is rejected. | `escrow-payment-verification.test.ts` |
| Merchant isolation | Merchant A's funded escrow cannot pay merchant B's order. | `escrow-payment-verification.test.ts` |
| Route dispatch | New orders are verified from escrow state; legacy direct orders use transfer verification. Both confirm routes do this. | `confirmation-state-integrity.test.ts` |
| Legacy direct transfers | Wrong mint, buyer authority, source, destination, amount or balance delta is rejected. | `payment-validation.test.ts`, `multi-merchant-solana.test.ts` |

## Signatures and order state

| Check | Expected result | Evidence |
| --- | --- | --- |
| Duplicate signature | One signature cannot pay two orders. The same signature for the same order is idempotent. | `signature-protection.test.ts` |
| Signature overwrite | A second, different signature cannot replace the first. | `signature-protection.test.ts` |
| Pending or invalid signature | It is not bound, does not fail the order, and does not block a later legitimate signature. Both confirm routes are covered. | `confirmation-state-integrity.test.ts` |
| Expiry race | Expiry is re-checked after asynchronous verification, before binding. | `confirmation-state-integrity.test.ts` |
| Inventory | No overselling, sold-out variants are blocked, and sequential reservations never go negative. | `inventory.test.ts` |
| Lifecycle | A pending order expires after ten minutes and releases stock once. A failed order releases once. A paid order stays paid. | `order-lifecycle.test.ts` |

## Escrow lifecycle

| Check | Expected result | Evidence |
| --- | --- | --- |
| Instruction shape | `mark_shipped`, `confirm_receipt`, `refund` and `claim` are each one exact instruction with the sponsor as fee payer. | `escrow-actions.test.ts` |
| Payout destinations | Confirm pays only the merchant ATA and refund only the buyer ATA. Vault rent returns to the recorded rent payer. A missing destination account is refused. | `escrow-actions.test.ts` |
| Time rules | Buyer reclaim only after the ship window and only while unshipped. Merchant claim only after the protection window. | `escrow-actions.test.ts` |
| Submit binding | Rejected: no prepared action, a different action, an extra instruction or program, a re-prepared message. The sponsor signs last. | `escrow-actions.test.ts` |
| Sync | Reads deadlines from chain, never moves status backwards, ignores unauthenticated accounts, leaves terminal and direct orders alone, never releases inventory. | `escrow-actions.test.ts` |
| Route access | Authentication is required. Strangers get 404, as does a merchant DID with a different wallet. Client-supplied action details are rejected. | `escrow-routes.test.ts` |
| Order view | The buyer sees only the buyer role. The merchant DID and prepared-action binding are never exposed. GET does not touch chain state. | `escrow-routes.test.ts` |
| UI action rules | Buttons follow status and deadlines. Blink / Phantom orders get no buyer buttons. Revenue splits released from in-escrow. | `escrow-ui.test.ts` |
| Client action flow | prepare, sign, submit only the signed bytes, then sync. Stops on a rejected prepare or a cancelled signature. | `escrow-ui.test.ts` |

## Merchant identity and isolation

| Check | Expected result | Evidence |
| --- | --- | --- |
| Self-service access | Any valid Privy user gets a workspace. Missing or invalid tokens and config errors give controlled errors. | `merchant-auth.test.ts` |
| Product isolation | Private lists, edit and delete are scoped to the verified DID. Public discovery stays available. | `merchant-auth.test.ts` |
| Order isolation | Merchants list and read only their own orders. Manual orders require product ownership. | `merchant-auth.test.ts` |
| Payout snapshot | Orders copy the merchant DID and wallet from the product. An Action request cannot override them. | `merchant-auth.test.ts` |
| Payout readiness | The profile shows only the caller's wallet and reports the exact ATA state. Lookup failures are controlled. | `merchant-profile.test.ts`, `multi-merchant-solana.test.ts` |
| Legacy JSON | Old records normalize only through the optional legacy inputs. Pre-escrow orders are marked direct. | `legacy-migration.test.ts` |

## Not covered

- **End-to-end Devnet run.** Not in CI. Follow [DEMO.md](./DEMO.md) manually.
- **Memo binding (4F).** Not implemented. The order is bound on-chain through
  the order PDA, which is derived from `sha256` of the order id.
