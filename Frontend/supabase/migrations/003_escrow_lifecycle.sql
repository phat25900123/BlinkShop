-- Escrow order lifecycle: shipped, released (merchant paid), refunded.
-- These statuses mirror verified on-chain escrow state.

alter table public.orders drop constraint if exists orders_status_check;
alter table public.orders
  add constraint orders_status_check check (
    status in (
      'pending', 'paid', 'shipped', 'released', 'refunded', 'failed', 'cancelled'
    )
  );

alter table public.orders
  add column if not exists shipped_at timestamptz,
  add column if not exists released_at timestamptz,
  add column if not exists refunded_at timestamptz,
  -- Last lifecycle transaction the sponsor co-signed for the order.
  add column if not exists escrow_action_signature text,
  -- Outstanding prepared lifecycle transaction: {action, signer, messageHash, preparedAt}.
  add column if not exists escrow_action jsonb
    check (escrow_action is null or jsonb_typeof(escrow_action) = 'object');

-- Released/refunded orders must stay in a terminal state with escrow settlement.
alter table public.orders
  add constraint orders_lifecycle_requires_escrow check (
    status not in ('shipped', 'released', 'refunded') or settlement = 'escrow'
  );
