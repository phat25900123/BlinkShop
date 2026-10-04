# Payment verification

The frontend is not the source of truth for payment validity.

## Confirmation sequence

1. A pending order already exists server-side. Its price, buyer, merchant, quantity, and reservation were derived from server-owned product data.
2. The server returns an unsigned SPL USDC transaction.
3. Phantom signs it, and the client broadcasts it to Solana Devnet.
4. The client submits the `txSignature` for the existing order.
5. The backend rejects an expired or failed order and prevents a different signature from replacing one already attached.
6. The backend rejects a signature already attached to another order, then immutably attaches the first acceptable signature to this order.
7. The backend fetches the parsed transaction from Solana with confirmed commitment. A transaction not yet available remains pending and can be retried.
8. The backend rejects a transaction whose execution failed.
9. The backend derives the expected buyer and merchant associated token accounts for the configured USDC mint.
10. It validates the SPL Token transfer instruction: buyer authority, source account, merchant destination account, configured mint, and exact base-unit amount.
11. It validates an exact positive merchant balance delta and exact negative buyer balance delta for that mint.
12. Only after every check passes does the order become `paid`. Its reserved inventory is retained as consumed inventory.

An invalid payment moves the pending order to `failed` and releases its reservation. A temporary RPC or confirmation delay does not fail the order; confirmation returns a pending response so the same signature can be retried.

## Signature rules

| Situation | Result |
| --- | --- |
| Same signature + same order | Safe, idempotent retry; a paid order remains paid. |
| Same signature + another order | Rejected; one Solana transaction cannot pay multiple orders. |
| Order has signature A, then receives signature B | Rejected; signature A remains unchanged. |

The stored signature is used for auditability and Solana Explorer links. These rules are enforced before an order can transition to paid.

## Deferred hardening

Order-to-transaction binding with a Solana Memo containing the `orderId` is **not implemented in the MVP**. This is explicitly deferred; a future implementation should add the memo while constructing the transaction and verify it during confirmation. Existing buyer, token-account, merchant, mint, amount, balance-delta, success, and uniqueness checks remain mandatory.
