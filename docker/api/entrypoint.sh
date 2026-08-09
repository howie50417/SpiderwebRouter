#!/bin/sh
set -eu

load_secret() {
  variable_name="$1"
  file_variable_name="${variable_name}_FILE"
  file_path="$(printenv "$file_variable_name" 2>/dev/null || true)"

  if [ -z "$file_path" ]; then
    return 0
  fi
  if [ ! -r "$file_path" ]; then
    echo "Required secret file for ${variable_name} is not readable." >&2
    exit 1
  fi

  secret_value="$(cat "$file_path")"
  if [ -z "$secret_value" ]; then
    echo "Required secret ${variable_name} is empty." >&2
    exit 1
  fi
  export "${variable_name}=${secret_value}"
  unset secret_value
}

for secret_name in \
  POSTGRES_PASSWORD \
  REDIS_PASSWORD \
  SESSION_SECRET \
  API_KEY_PEPPER \
  PROVIDER_ENCRYPTION_KEY \
  KEYCLOAK_ADMIN_PASSWORD \
  KEYCLOAK_CLIENT_SECRET \
  OIDC_CLIENT_SECRET \
  INITIAL_ADMIN_PASSWORD
do
  load_secret "$secret_name"
done

if [ -z "${OIDC_CLIENT_SECRET:-}" ] && [ -n "${KEYCLOAK_CLIENT_SECRET:-}" ]; then
  export OIDC_CLIENT_SECRET="$KEYCLOAK_CLIENT_SECRET"
fi

if [ -z "${DATABASE_URL:-}" ]; then
  DATABASE_URL="$(node -e '
    const encode = encodeURIComponent;
    const user = encode(process.env.POSTGRES_USER ?? "spiderwebrouter");
    const password = encode(process.env.POSTGRES_PASSWORD ?? "");
    const host = process.env.POSTGRES_HOST ?? "postgres";
    const port = process.env.POSTGRES_PORT ?? "5432";
    const database = encode(process.env.POSTGRES_DB ?? "spiderwebrouter");
    process.stdout.write(`postgresql://${user}:${password}@${host}:${port}/${database}?schema=app`);
  ')"
  export DATABASE_URL
fi

if [ -z "${REDIS_URL:-}" ]; then
  REDIS_URL="$(node -e '
    const password = encodeURIComponent(process.env.REDIS_PASSWORD ?? "");
    process.stdout.write(`redis://:${password}@redis:6379/0`);
  ')"
  export REDIS_URL
fi

exec "$@"
