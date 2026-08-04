#!/bin/sh
set -eu

# ECS injects the RDS managed-secret fields separately. Build DATABASE_URL only
# in process memory so that a composed credential never exists in the image or
# CloudFormation template. Local development may continue to provide it directly.
if [ -z "${DATABASE_URL:-}" ] && [ -n "${DB_HOST:-}" ]; then
  : "${DB_PORT:=3306}"
  : "${DB_NAME:?DB_NAME is required when DB_HOST is set}"
  : "${DB_USER:?DB_USER is required when DB_HOST is set}"
  : "${DB_PASSWORD:?DB_PASSWORD is required when DB_HOST is set}"
  : "${DB_CONNECTION_LIMIT:=5}"

  DATABASE_URL="$(node -e '
    const [user, password, host, port, database, limit] = process.argv.slice(1);
    const encode = encodeURIComponent;
    process.stdout.write(
      `mysql://${encode(user)}:${encode(password)}@${host}:${port}/${encode(database)}` +
      `?sslcert=${encode("/etc/ssl/certs/aws-rds-global-bundle.pem")}` +
      `&sslaccept=strict&connection_limit=${encode(limit)}`,
    );
  ' "$DB_USER" "$DB_PASSWORD" "$DB_HOST" "$DB_PORT" "$DB_NAME" "$DB_CONNECTION_LIMIT")"
  export DATABASE_URL
fi

exec "$@"
