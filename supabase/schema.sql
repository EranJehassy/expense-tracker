-- Expense tracker schema. Run once in Supabase: SQL Editor -> New query -> paste -> Run.
-- Every row belongs to a user (user_id) and Row Level Security guarantees users only ever see their own rows.

create table if not exists public.categories (
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  id      text not null,
  name    text not null,
  icon    text not null,
  color   text not null,
  sort    int  not null default 0,
  primary key (user_id, id)
);

create table if not exists public.transactions (
  user_id  uuid not null default auth.uid() references auth.users (id) on delete cascade,
  id       text not null,
  type     text not null check (type in ('income', 'expense')),
  amount   numeric(14, 2) not null check (amount >= 0),
  date     date not null,
  cat_id   text,
  kind     text check (kind in ('salary', 'reserve', 'other')),
  detail   text,
  note     text,
  rule_id  text,
  rule_key text,
  primary key (user_id, id)
);
create index if not exists transactions_user_date_idx on public.transactions (user_id, date desc);

create table if not exists public.recurring_rules (
  user_id    uuid not null default auth.uid() references auth.users (id) on delete cascade,
  id         text not null,
  type       text not null check (type in ('income', 'expense')),
  amount     numeric(14, 2) not null check (amount >= 0),
  cat_id     text,
  kind       text check (kind in ('salary', 'reserve', 'other')),
  detail     text,
  note       text,
  day        int  not null check (day between 1 and 31),
  rule_start date not null,
  skip       text[] not null default '{}',
  primary key (user_id, id)
);

create table if not exists public.budgets (
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  cat_id  text not null,
  amount  numeric(14, 2) not null check (amount >= 0),
  primary key (user_id, cat_id)
);

-- Row Level Security: a user can read/write only rows where user_id = their own id.
alter table public.categories      enable row level security;
alter table public.transactions    enable row level security;
alter table public.recurring_rules enable row level security;
alter table public.budgets         enable row level security;

do $$
declare t text;
begin
  foreach t in array array['categories', 'transactions', 'recurring_rules', 'budgets'] loop
    execute format('drop policy if exists "own rows" on public.%I', t);
    execute format(
      'create policy "own rows" on public.%I for all to authenticated
         using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id)', t);
  end loop;
end $$;
