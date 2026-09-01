-- Run as the app schema owner after creating a LOGIN role securely outside Git.
-- psql variable runtime_role must be an identifier, for example:
--   psql "$DIRECT_URL" --set=runtime_role=oshi_runtime --file prisma/runtime-role.sql
-- This script intentionally does not create a role or accept a password.

REVOKE ALL ON SCHEMA app FROM PUBLIC;
REVOKE ALL ON ALL TABLES IN SCHEMA app FROM PUBLIC;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA app FROM PUBLIC;

GRANT USAGE ON SCHEMA app TO :"runtime_role";
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA app TO :"runtime_role";
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA app TO :"runtime_role";

ALTER DEFAULT PRIVILEGES IN SCHEMA app
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO :"runtime_role";
ALTER DEFAULT PRIVILEGES IN SCHEMA app
  GRANT USAGE, SELECT ON SEQUENCES TO :"runtime_role";
