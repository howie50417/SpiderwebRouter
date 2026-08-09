#!/bin/sh
set -eu

if [ -z "${KEYCLOAK_DB_PASSWORD_FILE:-}" ] || [ ! -r "$KEYCLOAK_DB_PASSWORD_FILE" ]; then
  echo "KEYCLOAK_DB_PASSWORD_FILE is not readable." >&2
  exit 1
fi

keycloak_password="$(cat "$KEYCLOAK_DB_PASSWORD_FILE")"
if [ -z "$keycloak_password" ]; then
  echo "Keycloak database password is empty." >&2
  exit 1
fi

keycloak_user="${KEYCLOAK_DB_USER:-keycloak}"
keycloak_database="${KEYCLOAK_DB_NAME:-keycloak}"

psql --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" --set ON_ERROR_STOP=1 \
  --set app_owner="$POSTGRES_USER" <<'EOSQL'
CREATE SCHEMA IF NOT EXISTS app AUTHORIZATION :"app_owner";
GRANT ALL ON SCHEMA app TO :"app_owner";
EOSQL

role_exists="$(
  psql --username "$POSTGRES_USER" --dbname postgres --tuples-only --no-align \
    --set keycloak_user="$keycloak_user" <<'EOSQL'
SELECT 1 FROM pg_roles WHERE rolname = :'keycloak_user';
EOSQL
)"
if [ "$role_exists" != "1" ]; then
  psql --username "$POSTGRES_USER" --dbname postgres --set ON_ERROR_STOP=1 \
    --set keycloak_user="$keycloak_user" --set keycloak_password="$keycloak_password" <<'EOSQL'
CREATE ROLE :"keycloak_user" LOGIN PASSWORD :'keycloak_password';
EOSQL
fi

database_exists="$(
  psql --username "$POSTGRES_USER" --dbname postgres --tuples-only --no-align \
    --set keycloak_database="$keycloak_database" <<'EOSQL'
SELECT 1 FROM pg_database WHERE datname = :'keycloak_database';
EOSQL
)"
if [ "$database_exists" != "1" ]; then
  createdb --username "$POSTGRES_USER" --owner "$keycloak_user" "$keycloak_database"
fi

unset keycloak_password
