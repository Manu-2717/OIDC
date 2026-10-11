-- USAR FOSS OIDC: the durable data. (Sessions, codes and tokens are short lived and live in Redis.)

create table accounts (
  -- The `sub` every app sees. Ours alone: not a GitHub id, and never reused.
  id                     uuid primary key default gen_random_uuid(),
  -- GitHub's numeric id: stable for the life of the GitHub account, even if the username changes.
  github_id              bigint not null unique,
  login                  text not null,
  name                   text,
  email                  text,
  email_verified         boolean not null default false,
  picture                text,
  -- 'blocked' ends a person's sessions and refuses their sign in, everywhere, within minutes.
  status                 text not null default 'active' check (status in ('active', 'blocked')),
  -- A copy of what the main website's database said last, kept so sign in survives an outage there.
  member                 boolean not null default false,
  role                   text,
  membership_checked_at  timestamptz,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),
  last_login_at          timestamptz
);

create index accounts_login_idx on accounts (lower(login));

create table audit_log (
  id          bigint generated always as identity primary key,
  at          timestamptz not null default now(),
  event       text not null,
  account_id  uuid,
  client_id   text,
  ip          text,
  user_agent  text,
  detail      jsonb
);

create index audit_log_at_idx on audit_log (at desc);
create index audit_log_account_idx on audit_log (account_id, at desc);
