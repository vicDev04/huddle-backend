-- Admin role. Rights come only from this column; there is no endpoint that sets it.
alter table users add column if not exists is_admin boolean not null default false;

-- The account with username "Huddle" is the admin. username is citext, so this is case-insensitive.
update users set is_admin = true where username = 'Huddle';
