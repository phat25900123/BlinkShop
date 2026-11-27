-- Escrow integration: record how each order's USDC moved.
-- Existing rows predate the escrow program and were direct transfers.

alter table public.orders
  add column if not exists settlement text not null default 'direct'
    check (settlement in ('escrow', 'direct'));

-- True when BlinkShop's fee sponsor paid the fee and rent for the order.
-- Used by the global daily sponsorship cap.
alter table public.orders
  add column if not exists sponsored boolean not null default false;

create index if not exists orders_sponsored_created_at_idx
  on public.orders (created_at desc)
  where sponsored;
