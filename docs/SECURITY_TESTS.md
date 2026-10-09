# Security tests

The deterministic suite lives in `Frontend/tests/` and runs with `npm test`. It uses an in-memory store and parsed-transaction fixtures: no Phantom session, public RPC, Railway service, or funded wallet is required.

Last local verification for this server-sponsored Phase 2 pass: **101 tests across 11 test files passed**. The final quality-gate results should also be checked in the task report or CI run for the working tree under review.

## Results

| Check | Expected result | Evidence | Status |
| --- | --- | --- | --- |
| 4A — Overselling | Cannot reserve or purchase more inventory than available. | Automated total-stock and sequential-reservation tests. | PASS |
| 4B — Sold-out variant | Checkout/order reservation is blocked. | Automated zero-stock variant test; Action and order routes also validate availability. | PASS |
| 4C — Duplicate `txSignature` | One Solana transaction cannot pay multiple orders. | Automated confirmation-route test. | PASS |
| 4D — Wrong amount | Backend rejects a mismatched transfer amount. | Automated parsed-transaction validation test. | PASS |
| 4E — Wrong buyer | Backend rejects an unexpected authority or source token account. | Automated authority and source-account tests. | PASS |
| Signature overwrite | A different second signature cannot replace the first attached signature. | Automated confirmation-route immutability test. | PASS |
| Pending signature poisoning | An unverified signature is not attached and the reservation remains intact. | Automated tests for generic and Solana Action confirmation routes. | PASS |
| Invalid signature poisoning | An arbitrary invalid signature cannot fail the order or release inventory. | Automated tests for generic and Solana Action confirmation routes. | PASS |
| Pending expiry | An expired pending order releases its reservation once. | Fake-clock lifecycle test using the ten-minute deadline. | PASS |
| Failed payment | A failed order releases inventory safely and cannot double-release it. | Automated lifecycle tests. | PASS |
| Merchant/mint/deltas | Wrong recipient, wrong mint, or incorrect buyer/merchant balance delta is rejected. | Automated parsed-transaction validation tests. | PASS |
| Valid payment evidence | A successful transfer matching every server expectation is accepted. | Automated parsed-transaction validation test. | PASS |
| Sponsor transaction shape | Only one exact SPL `TransferChecked` is eligible; ATA creation, close, System, Compute Budget, and extra instructions are rejected. | Builder and server submission tests. | PASS |
| Sponsor signing boundary | The buyer signature, fee payer, order ownership/status, accounts, mint, amount, decimals, blockhash, and fee cap are checked before the sponsor signs. | Deterministic partial-signature and tamper tests. | PASS |
| Broadcast safety | Fully signed bytes verify before broadcast; an ambiguous RPC failure leaves the order pending. | Deterministic broadcast dependency tests. | PASS |
| 4F — Memo binding | Transaction carries and verifies its `orderId`. | Not present in the MVP. | DEFERRED / NOT IMPLEMENTED |

## Manual review checklist

For a release candidate, supplement CI with the Devnet flow in [`DEMO.md`](./DEMO.md): confirm the order appears as paid, its signature opens on Solana Explorer, and total plus selected-variant inventory reflect the purchase. Also inspect that a sold-out variant is disabled/readable and an over-quantity request is rejected. Devnet availability is not part of the deterministic CI suite.

Do not convert the deferred Memo test to PASS until transaction construction and backend verification both bind the on-chain transfer to the exact order ID.
