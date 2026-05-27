-- ═══════════════════════════════════════════════════════════════
-- Monopoly Bank — Database Schema
-- Run this ONCE in your Supabase project's SQL editor:
-- https://app.supabase.com → your project → SQL editor → New query
-- ═══════════════════════════════════════════════════════════════

create table if not exists games (
  id                  text primary key,
  created_at          timestamptz default now(),
  starting_balance    integer     not null default 1500,
  approval_threshold  text        not null default 'majority', -- majority | unanimous | any1
  status              text        not null default 'lobby',    -- lobby | active | ended
  current_turn_id     uuid        -- which player's turn it is (set when game starts)
);

create table if not exists players (
  id          uuid    primary key default gen_random_uuid(),
  game_id     text    references games(id) on delete cascade,
  name        text    not null,
  balance     integer not null,
  turn_order  integer,
  is_active   boolean default true,
  joined_at   timestamptz default now()
);

create table if not exists transactions (
  id             uuid    primary key default gen_random_uuid(),
  game_id        text    not null,
  created_at     timestamptz default now(),
  initiator_id   uuid    references players(id),
  from_player_id uuid    references players(id),  -- null means bank is the source
  to_player_id   uuid    references players(id),  -- null means bank is the destination
  to_everyone    boolean default false,            -- true = pay/collect to/from all other players
  amount         integer not null,
  description    text,
  status         text    not null default 'completed' -- pending_approval | approved | denied | completed
);

create table if not exists votes (
  id             uuid primary key default gen_random_uuid(),
  transaction_id uuid references transactions(id) on delete cascade,
  player_id      uuid references players(id),
  vote           text not null,  -- approve | deny
  created_at     timestamptz default now(),
  constraint unique_vote unique (transaction_id, player_id)
);

create table if not exists dice_rolls (
  id         uuid    primary key default gen_random_uuid(),
  game_id    text    not null,
  player_id  uuid    references players(id),
  die1       integer not null,
  die2       integer not null,
  rolled_at  timestamptz default now()
);

-- ── Row-Level Security ────────────────────────────────────────────
-- Permissive: the game ID in the URL acts as the access token.
-- Anyone who has the URL/QR code can participate.
alter table games        enable row level security;
alter table players      enable row level security;
alter table transactions enable row level security;
alter table votes        enable row level security;
alter table dice_rolls   enable row level security;

create policy "open_games"        on games        for all using (true) with check (true);
create policy "open_players"      on players      for all using (true) with check (true);
create policy "open_transactions" on transactions for all using (true) with check (true);
create policy "open_votes"        on votes        for all using (true) with check (true);
create policy "open_dice"         on dice_rolls   for all using (true) with check (true);

-- ── Enable Realtime on all tables ────────────────────────────────
alter publication supabase_realtime add table games;
alter publication supabase_realtime add table players;
alter publication supabase_realtime add table transactions;
alter publication supabase_realtime add table votes;
alter publication supabase_realtime add table dice_rolls;
