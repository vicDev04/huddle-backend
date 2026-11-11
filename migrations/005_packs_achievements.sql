-- Update 5: deck packs, achievements, weekly crew challenges, player profiles.

-- Deck packs. A crew plays one pack at a time; a change applies from the next game day.
alter table groups add column if not exists pack varchar(16) not null default 'classic';
alter table groups add column if not exists pack_prev varchar(16) null;
alter table groups add column if not exists pack_from date null;
alter table hive_questions add column if not exists pack varchar(16) not null default 'classic';
alter table hot_seat_prompts add column if not exists pack varchar(16) not null default 'classic';
create index if not exists hive_questions_pack on hive_questions (pack) where group_id is null;
create index if not exists hot_seat_prompts_pack on hot_seat_prompts (pack);

alter table groups drop constraint if exists groups_pack_check;
alter table groups add constraint groups_pack_check check (pack in ('classic','spicy','office','family','couples'));
alter table groups drop constraint if exists groups_pack_prev_check;
alter table groups add constraint groups_pack_prev_check check (pack_prev is null or pack_prev in ('classic','spicy','office','family','couples'));
alter table hive_questions drop constraint if exists hive_questions_pack_check;
alter table hive_questions add constraint hive_questions_pack_check check (pack in ('classic','spicy','office','family','couples'));
alter table hot_seat_prompts drop constraint if exists hot_seat_prompts_pack_check;
alter table hot_seat_prompts add constraint hot_seat_prompts_pack_check check (pack in ('classic','spicy','office','family','couples'));

-- Achievements a player has unlocked (rewards are paid once, at insert time).
create table if not exists user_achievements (
  user_id uuid not null references users(id) on delete cascade,
  achievement_id varchar(32) not null,
  unlocked_at timestamptz not null default now(),
  primary key (user_id, achievement_id)
);

-- Weekly crew challenge rewards that have been claimed.
create table if not exists crew_challenge_claims (
  group_id uuid not null references groups(id) on delete cascade,
  week_start date not null,
  user_id uuid not null references users(id) on delete cascade,
  coins integer not null,
  claimed_at timestamptz not null default now(),
  primary key (group_id, week_start, user_id)
);
create index if not exists crew_challenge_claims_user on crew_challenge_claims (user_id);

alter table user_items drop constraint if exists user_items_source_check;
alter table user_items add constraint user_items_source_check check (source in ('shop','code','season','grant','achievement'));

create index if not exists points_ledger_user_day on points_ledger (user_id, day);
create index if not exists mini_game_plays_user on mini_game_plays (user_id);

-- Seed the new packs (idempotent).
insert into hive_questions (pack, text, is_active)
select v.pack, v.text, true from (values
  ('spicy', 'Who''s most likely to have a secret crush on someone in this crew?'),
  ('spicy', 'Who''s the best flirt in the group?'),
  ('spicy', 'Who would handle a blind date with the least awkwardness?'),
  ('spicy', 'Who''s most likely to text their ex at 2am?'),
  ('spicy', 'Who has the most dramatic love-life stories?'),
  ('spicy', 'Who''s most likely to fall in love on holiday?'),
  ('spicy', 'Who would be the worst at hiding a crush?'),
  ('spicy', 'Who has a pet name for their partner that makes everyone cringe?'),
  ('spicy', 'Who would sign up for a reality dating show?'),
  ('spicy', 'Who''s most likely to kiss a stranger on New Year''s Eve?'),
  ('spicy', 'Who gives the most unsolicited relationship advice?'),
  ('spicy', 'Who''s most likely to get a stranger''s number tonight?'),
  ('spicy', 'Who''s most likely to ghost someone?'),
  ('spicy', 'Who would be the first to slide into someone''s DMs?'),
  ('spicy', 'Who would be the best wingperson?'),
  ('spicy', 'Who''s most likely to wear something outrageous on a first date?'),
  ('spicy', 'Who gets the most jealous when someone else gets attention?'),
  ('spicy', 'Who''s most likely to be caught stalking an ex''s profile?'),
  ('spicy', 'Who''s the biggest hopeless romantic?'),
  ('spicy', 'Who would last the longest without flirting with anybody?'),
  ('spicy', 'Who''s most likely to date someone from this friend group?'),
  ('spicy', 'Who has the best dance-floor moves?'),
  ('spicy', 'Who''s most likely to cry at a wedding?'),
  ('spicy', 'Who would propose after one year together?'),
  ('office', 'Who''s most likely to reply "per my last email"?'),
  ('office', 'Who would survive the longest in back-to-back meetings?'),
  ('office', 'Who''s most likely to become the CEO?'),
  ('office', 'Who''s most likely to talk for five minutes while on mute?'),
  ('office', 'Who would steal your lunch from the office fridge?'),
  ('office', 'Who''s most likely to be late to their own meeting?'),
  ('office', 'Who would bring the best snacks to the office?'),
  ('office', 'Who''s most likely to say "this could have been an email"?'),
  ('office', 'Who would win employee of the month every month?'),
  ('office', 'Who''s most likely to fall asleep during a presentation?'),
  ('office', 'Who''s most likely to send a message to the wrong group chat?'),
  ('office', 'Who would be the best boss?'),
  ('office', 'Who would be the most chaotic boss?'),
  ('office', 'Who''s most likely to quit dramatically?'),
  ('office', 'Who has the messiest desk?'),
  ('office', 'Who''s most likely to take a three-hour lunch?'),
  ('office', 'Who would crack first during a deadline?'),
  ('office', 'Who would organise the best team-building day?'),
  ('office', 'Who has the most unread emails?'),
  ('office', 'Who''s the office gossip?'),
  ('office', 'Who''s most likely to start a side hustle during work hours?'),
  ('office', 'Who would survive a week with no coffee?'),
  ('office', 'Who''s most likely to answer emails at midnight?'),
  ('office', 'Who would schedule a meeting to plan a meeting?'),
  ('family', 'Who''s most likely to fall asleep on the sofa after dinner?'),
  ('family', 'Who''s the best cook in the family?'),
  ('family', 'Who''s most likely to tell the same story every holiday?'),
  ('family', 'Who would win family board-game night?'),
  ('family', 'Who''s most likely to cry at a family reunion?'),
  ('family', 'Who''s most likely to lose the TV remote?'),
  ('family', 'Who gives the best hugs?'),
  ('family', 'Who''s most likely to be late to Sunday lunch?'),
  ('family', 'Who would be the funniest at a family talent show?'),
  ('family', 'Who''s most likely to take 200 photos at a family event?'),
  ('family', 'Who''s most likely to start an argument in the family group chat?'),
  ('family', 'Who would hide the last piece of cake?'),
  ('family', 'Who''s most likely to forget someone''s birthday?'),
  ('family', 'Who''s the family''s tech support?'),
  ('family', 'Who''s most likely to sneak seconds at dinner?'),
  ('family', 'Who would win a family karaoke night?'),
  ('family', 'Who''s most likely to get lost on a family trip?'),
  ('family', 'Who gives the best advice?'),
  ('family', 'Who would be the grandparent who spoils everyone?'),
  ('family', 'Who would win a family Olympics?'),
  ('family', 'Who would still be dancing at the end of the family party?'),
  ('family', 'Who''s most likely to fall for an April Fools'' prank?'),
  ('family', 'Who tells the worst jokes?'),
  ('family', 'Who would organise the best family holiday?'),
  ('couples', 'Who falls asleep first at the movies?'),
  ('couples', 'Who said "I love you" first?'),
  ('couples', 'Who is more likely to plan a surprise date?'),
  ('couples', 'Who steals the blanket?'),
  ('couples', 'Who takes longer to get ready?'),
  ('couples', 'Who is more likely to cry at a romantic film?'),
  ('couples', 'Who is the better cook?'),
  ('couples', 'Who is more likely to forget an anniversary?'),
  ('couples', 'Who is more stubborn in an argument?'),
  ('couples', 'Who says sorry first?'),
  ('couples', 'Who spends more time on their phone in bed?'),
  ('couples', 'Who is more likely to get lost on a trip?'),
  ('couples', 'Who is the messier one at home?'),
  ('couples', 'Who is more likely to suggest a spontaneous trip?'),
  ('couples', 'Who is more likely to refuse to ask for directions?'),
  ('couples', 'Who sings more in the shower?'),
  ('couples', 'Who is more likely to adopt a pet without asking?'),
  ('couples', 'Who is more romantic?'),
  ('couples', 'Who is more likely to eat the last bite off the other''s plate?'),
  ('couples', 'Who is more likely to binge a whole series without waiting?'),
  ('couples', 'Who is always early?'),
  ('couples', 'Who is the better dancer?'),
  ('couples', 'Who is more likely to propose a toast at dinner?'),
  ('couples', 'Who takes more photos on holiday?')
) as v(pack, text)
where not exists (select 1 from hive_questions h where h.pack = v.pack and h.text = v.text);

insert into hot_seat_prompts (pack, text, is_active)
select v.pack, v.text, true from (values
  ('spicy', 'What would {name}''s most embarrassing text-to-the-wrong-person be?'),
  ('spicy', 'What''s {name}''s signature pick-up line?'),
  ('spicy', 'Describe {name}''s ideal first date in one sentence.'),
  ('spicy', 'What would {name}''s biggest red flag be on a dating profile?'),
  ('spicy', 'What would {name}''s catchphrase be on a dating show?'),
  ('spicy', 'What''s {name}''s love language, honestly?'),
  ('spicy', 'How would {name} get over a breakup?'),
  ('spicy', 'What song would {name} dedicate to their crush?'),
  ('spicy', 'What would {name}''s horoscope say about their love life this week?'),
  ('spicy', 'What''s the worst date idea {name} would think is romantic?'),
  ('spicy', 'What would {name} wear to impress someone?'),
  ('spicy', 'What would {name}''s most dramatic "we need to talk" moment be?'),
  ('office', 'What would {name}''s out-of-office message really say?'),
  ('office', 'What would {name}''s job title be if it were honest?'),
  ('office', 'What would {name} do on their first day as CEO?'),
  ('office', 'What''s {name}''s go-to excuse for being late?'),
  ('office', 'What would {name}''s LinkedIn headline be?'),
  ('office', 'What would {name}''s desk say about them?'),
  ('office', 'What does {name} say in a meeting when they haven''t been listening?'),
  ('office', 'What''s {name}''s secret office talent?'),
  ('office', 'What would the title of {name}''s TED talk be?'),
  ('office', 'What does {name}''s coffee order say about them?'),
  ('office', 'What would {name} sneak out of the supply cupboard?'),
  ('office', 'How would {name}''s retirement speech start?'),
  ('family', 'What would {name} cook for the whole family with one hour to spare?'),
  ('family', 'What''s {name}''s funniest childhood nickname?'),
  ('family', 'What would {name}''s family recipe book be called?'),
  ('family', 'What would {name} say at dinner to start a family debate?'),
  ('family', 'What''s {name}''s signature move at family gatherings?'),
  ('family', 'What would {name}''s grandchildren say about them?'),
  ('family', 'What would {name} pack for a family road trip?'),
  ('family', 'What would {name}''s role be in a family sitcom?'),
  ('family', 'What''s {name}''s best dad joke?'),
  ('family', 'What''s the family''s inside joke about {name}?'),
  ('family', 'What would {name}''s perfect family Sunday look like?'),
  ('family', 'What would {name} win at the family awards night?'),
  ('couples', 'What''s {name}''s most romantic gesture ever?'),
  ('couples', 'What would {name}''s love story be called as a film?'),
  ('couples', 'What''s {name}''s idea of the perfect date night?'),
  ('couples', 'What nickname would {name}''s partner give them?'),
  ('couples', 'What would {name} cook for an anniversary dinner?'),
  ('couples', 'What''s {name}''s biggest "I told you so" moment?'),
  ('couples', 'What would {name} write in an anniversary card?'),
  ('couples', 'What does {name} do that secretly drives their partner crazy?'),
  ('couples', 'What song is "our song" for {name}?'),
  ('couples', 'What would {name} pack for a romantic weekend?'),
  ('couples', 'How would {name} propose?'),
  ('couples', 'What does {name} do when they are trying to apologise?')
) as v(pack, text)
where not exists (select 1 from hot_seat_prompts h where h.pack = v.pack and h.text = v.text);
