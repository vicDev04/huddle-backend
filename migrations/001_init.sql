create extension if not exists citext;
create extension if not exists pgcrypto;

create table users (
  id uuid primary key default gen_random_uuid(),
  username citext unique not null check (username ~ '^[a-zA-Z0-9_.]{3,20}$'),
  password_hash text not null,
  display_name varchar(20) not null,
  avatar varchar(64) not null,
  color varchar(7) not null check (color ~ '^#[0-9a-fA-F]{6}$'),
  created_at timestamptz not null default now()
);

create table groups (
  id uuid primary key default gen_random_uuid(),
  name varchar(30) not null,
  invite_code varchar(8) unique not null,
  created_by uuid not null references users(id),
  created_at timestamptz not null default now()
);

create table group_members (
  group_id uuid references groups(id) on delete cascade,
  user_id uuid references users(id) on delete cascade,
  joined_at timestamptz not null default now(),
  primary key (group_id, user_id)
);

create table hive_questions (
  id serial primary key,
  text varchar(140) not null,
  group_id uuid null references groups(id) on delete cascade,
  author_id uuid null references users(id),
  scheduled_day date null,
  is_active boolean not null default true
);

create table hot_seat_prompts (
  id serial primary key,
  text varchar(140) not null,
  is_active boolean not null default true
);

create table daily_rounds (
  group_id uuid references groups(id) on delete cascade,
  day date not null,
  member_ids uuid[] not null,
  hive_question_ids int[] not null,
  hot_seat_subject_id uuid not null references users(id),
  hot_seat_prompt_id int not null references hot_seat_prompts(id),
  primary key (group_id, day)
);

create table hive_votes (
  group_id uuid, day date, question_id int,
  voter_id uuid references users(id),
  voted_user_id uuid not null references users(id),
  predicted_user_id uuid not null references users(id),
  created_at timestamptz not null default now(),
  primary key (group_id, day, question_id, voter_id),
  foreign key (group_id, day) references daily_rounds(group_id, day) on delete cascade
);

create table hive_results (
  group_id uuid, day date, question_id int,
  majority_user_ids uuid[] not null,
  settled_at timestamptz not null default now(),
  primary key (group_id, day, question_id)
);

create table hot_seat_answers (
  id uuid primary key default gen_random_uuid(),
  group_id uuid not null, day date not null,
  author_id uuid not null references users(id),
  text varchar(140) not null,
  created_at timestamptz not null default now(),
  unique (group_id, day, author_id),
  foreign key (group_id, day) references daily_rounds(group_id, day) on delete cascade
);

create table hot_seat_favorites (
  group_id uuid, day date,
  answer_id uuid not null references hot_seat_answers(id) on delete cascade,
  chosen_at timestamptz not null default now(),
  primary key (group_id, day)
);

create table mini_game_plays (
  user_id uuid references users(id) on delete cascade,
  day date not null,
  game_key varchar(16) not null,
  raw jsonb not null,
  points int not null check (points between 0 and 100),
  created_at timestamptz not null default now(),
  primary key (user_id, day)
);

create table points_ledger (
  id bigserial primary key,
  user_id uuid not null references users(id) on delete cascade,
  group_id uuid null references groups(id) on delete cascade,
  season char(7) not null,
  day date not null,
  source varchar(24) not null check (source in ('hive','hot_seat','hot_seat_crowned','hot_seat_judge','mini_game')),
  amount int not null,
  ref text null,
  created_at timestamptz not null default now()
);
create index on points_ledger (season, group_id);
create index on points_ledger (season, source);
create index on points_ledger (user_id, season);
create unique index points_ledger_idem on points_ledger (user_id, source, day, coalesce(group_id::text,''), coalesce(ref,''));

create table season_rewards (
  id uuid primary key default gen_random_uuid(),
  season char(7) not null,
  scope varchar(6) not null check (scope in ('group','global')),
  group_id uuid null references groups(id) on delete cascade,
  user_id uuid not null references users(id) on delete cascade,
  rank smallint not null check (rank between 1 and 3),
  title varchar(40) not null,
  perk varchar(20) null,
  perk_used_at timestamptz null,
  created_at timestamptz not null default now(),
  unique (season, scope, group_id, user_id)
);
