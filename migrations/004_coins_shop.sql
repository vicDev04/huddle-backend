-- Coins, item shop, titles and redeem codes.
alter table users add column if not exists coins integer not null default 0 check (coins >= 0);
alter table users add column if not exists title_id varchar(40) null;

create table if not exists user_items (
  user_id uuid not null references users(id) on delete cascade,
  item_id varchar(40) not null,
  source varchar(16) not null check (source in ('shop', 'code', 'season', 'grant')),
  created_at timestamptz not null default now(),
  primary key (user_id, item_id)
);

create table if not exists codes (
  code citext primary key,
  item_ids text[] not null default '{}',
  coins integer not null default 0,
  max_redemptions integer null,
  expires_at timestamptz null,
  created_at timestamptz not null default now()
);
create table if not exists code_redemptions (
  code citext not null references codes(code) on delete cascade,
  user_id uuid not null references users(id) on delete cascade,
  redeemed_at timestamptz not null default now(),
  primary key (code, user_id)
);

insert into codes (code, item_ids) values
  ('HUDDLE-ALPHA', '{addon_alpha,shirt_alpha,title_alpha}'),
  ('HUDDLE-BETA',  '{style_beta,bg_beta}')
on conflict (code) do nothing;

-- One-off data backfills are recorded here so they can never run twice.
create table if not exists data_backfills (name text primary key, ran_at timestamptz not null default now());

do $$
begin
  insert into data_backfills (name) values ('004_coins') on conflict do nothing;
  if found then
    update users u set coins = coalesce(
      (select sum(ceil(l.amount / 5.0))::int from points_ledger l where l.user_id = u.id and l.amount > 0), 0);
  end if;
end $$;

insert into user_items (user_id, item_id, source)
select user_id,
       case when scope = 'group' then (array['title_crew_captain','title_first_mate','title_deckhand'])[rank]
            else (array['title_global_legend','title_global_ace','title_global_contender'])[rank] end,
       'season'
from season_rewards
on conflict do nothing;

-- Every positive ledger insert grants ceil(amount/5) coins, in the same transaction.
-- Created after the backfill so existing rows aren't counted twice.
create or replace function grant_coins_for_points() returns trigger language plpgsql as $$
begin
  if new.amount > 0 then
    update users set coins = coins + ceil(new.amount / 5.0)::int where id = new.user_id;
  end if;
  return new;
end $$;
drop trigger if exists points_ledger_coins on points_ledger;
create trigger points_ledger_coins after insert on points_ledger for each row execute function grant_coins_for_points();
