#!/bin/sh
set -eu

# Legacy/local runtimes may inject PostgreSQL fields separately. Lambda receives
# the complete pooled URL from Secrets Manager during initialization.
if [ -z "${DATABASE_URL:-}" ] && [ -n "${DB_HOST:-}" ]; then
  : "${DB_PORT:=5432}"
  : "${DB_NAME:?DB_NAME is required when DB_HOST is set}"
  : "${DB_USER:?DB_USER is required when DB_HOST is set}"
  : "${DB_PASSWORD:?DB_PASSWORD is required when DB_HOST is set}"
  : "${DB_CONNECTION_LIMIT:=5}"

  DATABASE_URL="$(node -e '
    const [user, password, host, port, database, limit] = process.argv.slice(1);
    const encode = encodeURIComponent;
    process.stdout.write(
      `postgresql://${encode(user)}:${encode(password)}@${host}:${port}/${encode(database)}` +
      `?schema=app&sslmode=require&pgbouncer=true&connection_limit=${encode(limit)}`,
    );
  ' "$DB_USER" "$DB_PASSWORD" "$DB_HOST" "$DB_PORT" "$DB_NAME" "$DB_CONNECTION_LIMIT")"
  export DATABASE_URL
fi

exec "$@"
