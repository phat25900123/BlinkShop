# Payment verification

The browser is never the source of truth for payment routing or validity.

## Server-owned expectation

When an order is reserved, the store loads the product and snapshots:

- `merchantId` from the product owner;
- `merchantWallet` from the product payout destination;
- buyer wallet resolved from Privy (or the Action account for Phantom);
- exact quantity, variant, and USDC amount.

Callers cannot pass merchant identity into `store.createOrder`. New products
receive their owner DID and embedded wallet from verified server-side Privy
identity. `SOLANA_USDC_MINT` remains configuration owned by the server.

## Sponsored Privy sequence

1. The backend reserves inventory and prepares exactly one `TransferChecked`
   from the authenticated buyer ATA to `order.merchantWallet`'s ATA.
2. BlinkShop's Devnet sponsor is fee payer; the buyer is transfer authority.
3. The buyer signs only. The browser returns the partial transaction.
4. Before sponsor signing, the backend rechecks product/order merchant
   consistency, buyer ownership, pending status, expiry, message hash, fee
   payer, required signers, buyer signature, exact instruction count/program,
   source, destination, mint, amount, decimals, blockhash, and fee cap.
5. The sponsor slot must be empty. BlinkShop signs last, verifies all signatures,
   serializes with strict checks, and broadcasts with preflight.
6. Broadcast success still does not mark the order paid; the standard
   confirmation verifier must validate on-chain evidence.

## Confirmation sequence

1. Reject a missing, expired, cancelled, or failed order.
2. Reject signature replacement or reuse on another order.
3. Fetch the parsed transaction at confirmed commitment.
4. Leave an unavailable transaction pending and do not attach its signature.
5. Reject a failed transaction.
6. Derive buyer and merchant ATAs using the configured mint and the order's
   exact buyer/merchant wallet snapshots.
7. Validate transfer authority, source, destination, mint, and base-unit amount.
8. Validate the exact negative buyer and positive merchant token-balance deltas.
9. Re-read mutable order state, atomically check signature uniqueness in the
   single-instance store, attach the verified signature, and mark the order paid.

The same verifier is used by generic and Solana Action confirmation routes.
Payment to the old global `MERCHANT_WALLET` cannot satisfy another merchant's
order.

## Signature rules

| Situation | Result |
| --- | --- |
| Same signature + same paid order | Idempotent success. |
| Same signature + another order | Rejected. |
| Order already has signature A; browser submits B | Rejected; A is preserved. |
| Signature pending or invalid | Not attached; reservation remains until valid confirmation or expiry. |

## ATA policy

Sponsored checkout never creates buyer or merchant ATAs. A new merchant must
first receive Devnet USDC (zero balance afterward is acceptable as long as the
ATA exists). `/api/merchant/me` reports readiness. This prevents arbitrary
users from draining the sponsor through token-account rent creation.

## Deferred hardening

Order-to-transaction Memo binding (test 4F) is not implemented. A future phase
should add `orderId` as a Memo instruction and verify it during confirmation;
all current buyer, owner, mint, amount, delta, status, and uniqueness checks
remain mandatory.
