-- BlinkShop Supabase persistence schema.
-- Run this in a Supabase project before wiring the production repository.
-- The service-role key must only be used by Next.js server code.

create table if not exists public.products (
  id text primary key,
  merchant_id text not null,
  merchant_wallet text not null,
  name text not null check (char_length(name) > 0),
  description text not null default '',
  price_usdc numeric(20, 6) not null check (price_usdc > 0),
  image_url text not null default '',
  inventory integer not null check (inventory >= 0),
  status text not null check (status in ('active', 'inactive', 'sold_out')),
  variants jsonb not null default '[]'::jsonb check (jsonb_typeof(variants) = 'array'),
  created_at timestamptz not null,
  updated_at timestamptz not null
);

create table if not exists public.orders (
  id text primary key,
  product_id text not null references public.products(id) on delete restrict,
  merchant_id text not null,
  merchant_wallet text not null,
  buyer_wallet text not null,
  variant text,
  quantity integer not null check (quantity > 0),
  amount_usdc numeric(20, 6) not null check (amount_usdc > 0),
  tx_signature text,
  status text not null check (status in ('pending', 'paid', 'failed', 'cancelled')),
  inventory_reserved boolean not null default false,
  created_at timestamptz not null,
  updated_at timestamptz not null,
  expires_at timestamptz not null
);

create unique index if not exists orders_tx_signature_unique
  on public.orders (tx_signature)
  where tx_signature is not null;

create index if not exists orders_product_id_idx on public.orders (product_id);
create index if not exists orders_created_at_idx on public.orders (created_at desc);
create index if not exists orders_pending_expiry_idx
  on public.orders (expires_at)
  where status = 'pending';

alter table public.products enable row level security;
alter table public.orders enable row level security;

-- No public policies are intentionally created. BlinkShop accesses these tables
-- from server-only code with SUPABASE_SERVICE_ROLE_KEY. Before enabling this
-- adapter, reservation, expiration and payment state transitions should be
-- implemented as transactional database functions to preserve oversell safety.
-- TODO: reserve_inventory_and_create_order, expire_order_and_release_inventory,
-- fail_order_and_release_inventory and confirm_paid_order.
