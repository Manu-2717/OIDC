-- Run in the MAIN website's database, as its owner, after the `oidc_members_view` migration has been deployed there.
--
-- It makes a login that can read the view `oidc_members_v` and nothing else (not the users table, and so not the stored GitHub tokens).
-- Make the password with `openssl rand -hex 24`.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'oidc_reader') THEN
    CREATE ROLE oidc_reader LOGIN PASSWORD 'REPLACE_ME_OIDC_READER_PASSWORD';
  END IF;
END
$$;

DO $$
BEGIN
  EXECUTE format('GRANT CONNECT ON DATABASE %I TO oidc_reader', current_database());
END
$$;

GRANT USAGE ON SCHEMA public TO oidc_reader;
GRANT SELECT ON oidc_members_v TO oidc_reader;

-- Nothing else is granted. Check it (as oidc_reader): this must work, and the second must say "permission denied".
--   SELECT count(*) FROM oidc_members_v;
--   SELECT count(*) FROM users;

ALTER ROLE oidc_reader SET statement_timeout = '5s';
ALTER ROLE oidc_reader SET idle_in_transaction_session_timeout = '5s';
