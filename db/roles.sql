-- Logins for the OIDC database. Run ONCE as the owner, in the SQL editor of the `ufc-oidc` Neon project.
--
-- The service runs as `oidc_app`: it can read and write rows, but it cannot change or drop tables, so a bug or a leaked address cannot
-- destroy the structure. The owner login is for `npm run db:migrate` and nothing else.
--
-- Make the password with `openssl rand -hex 24` (letters and digits only, so it can sit in a connection address as it is).

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'oidc_app') THEN
    CREATE ROLE oidc_app LOGIN PASSWORD 'REPLACE_ME_OIDC_APP_PASSWORD';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'oidc_backup') THEN
    CREATE ROLE oidc_backup LOGIN PASSWORD 'REPLACE_ME_OIDC_BACKUP_PASSWORD';
  END IF;
END
$$;

DO $$
BEGIN
  EXECUTE format('GRANT CONNECT ON DATABASE %I TO oidc_app, oidc_backup', current_database());
END
$$;

GRANT USAGE ON SCHEMA public TO oidc_app, oidc_backup;

GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO oidc_app;
GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA public TO oidc_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO oidc_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO oidc_app;

GRANT SELECT ON ALL TABLES IN SCHEMA public TO oidc_backup;
GRANT SELECT ON ALL SEQUENCES IN SCHEMA public TO oidc_backup;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO oidc_backup;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON SEQUENCES TO oidc_backup;

REVOKE CREATE ON SCHEMA public FROM PUBLIC;

ALTER ROLE oidc_app SET statement_timeout = '15s';
ALTER ROLE oidc_app SET idle_in_transaction_session_timeout = '15s';
ALTER ROLE oidc_backup SET statement_timeout = '10min';
