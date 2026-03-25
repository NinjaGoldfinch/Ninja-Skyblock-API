-- Create the api_anon role for PostgREST
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'api_anon') THEN
    CREATE ROLE api_anon NOLOGIN;
  END IF;
END
$$;

GRANT USAGE ON SCHEMA public TO api_anon;
GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA public TO api_anon;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE ON TABLES TO api_anon;
