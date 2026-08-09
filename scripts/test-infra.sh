#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd -- "${SCRIPT_DIR}/.." && pwd)"
TEST_TEMP_DIR=""

cleanup_test() {
  if [[ -n "$TEST_TEMP_DIR" && -d "$TEST_TEMP_DIR" ]]; then
    rm -rf -- "$TEST_TEMP_DIR"
  fi
}
trap cleanup_test EXIT

fail() {
  printf 'infra test failed: %s\n' "$1" >&2
  exit 1
}

command -v docker >/dev/null 2>&1 || fail "docker is required"
command -v python3 >/dev/null 2>&1 || fail "python3 is required"

cd "$REPO_ROOT"
bash -n \
  scripts/init-env.sh \
  docker/api/entrypoint.sh \
  docker/keycloak/entrypoint.sh \
  docker/postgres/init-databases.sh \
  docker/redis/entrypoint.sh

# Sourcing exposes the same permission function used by real initialization;
# the guarded main function does not execute when sourced.
# shellcheck source=init-env.sh
source "${SCRIPT_DIR}/init-env.sh"

TEST_TEMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/spiderwebrouter-infra-test.XXXXXX")"
test_environment="${TEST_TEMP_DIR}/.env"
test_secrets="${TEST_TEMP_DIR}/secrets"
mkdir -m 700 "$test_secrets"
printf '%s\n' 'test=true' > "$test_environment"
for secret_name in "${SECRET_NAMES[@]}"; do
  printf '%s' 'test-secret' > "${test_secrets}/${secret_name}"
done
chmod 600 "$test_environment" "${test_secrets}/"*

repair_secret_permissions "$test_environment" "$test_secrets"

file_mode() {
  if stat -c '%a' "$1" >/dev/null 2>&1; then
    stat -c '%a' "$1"
  else
    stat -f '%Lp' "$1"
  fi
}

[[ "$(file_mode "$test_environment")" == "600" ]] || fail ".env is not mode 600"
[[ "$(file_mode "$test_secrets")" == "700" ]] || fail "secrets directory is not mode 700"
for secret_name in "${SECRET_NAMES[@]}"; do
  [[ "$(file_mode "${test_secrets}/${secret_name}")" == "644" ]] \
    || fail "${secret_name} is not mode 644"
done

python3 - "${REPO_ROOT}/docker/keycloak/realm-export.json" <<'PY'
import json
import pathlib
import sys

with pathlib.Path(sys.argv[1]).open(encoding="utf-8") as realm_file:
    realm = json.load(realm_file)

assert realm["realm"] == "spiderwebrouter"
assert realm["registrationAllowed"] is False
totp = next(action for action in realm["requiredActions"] if action["alias"] == "CONFIGURE_TOTP")
assert totp["enabled"] is True
assert totp["defaultAction"] is False
PY

compose_json="$(docker compose --env-file .env.example -f docker-compose.yml config --format json 2>/dev/null)"
COMPOSE_JSON="$compose_json" python3 <<'PY'
import json
import os

compose = json.loads(os.environ["COMPOSE_JSON"])
services = compose["services"]
assert set(services) == {
    "edge", "api", "worker", "migrate", "bootstrap", "postgres", "redis", "keycloak"
}

published = []
for service_name, service in services.items():
    for port in service.get("ports") or []:
        published.append((service_name, str(port["published"]), str(port["target"])))
assert published == [("edge", "80", "80")]

for service_name in ("edge", "api", "worker", "postgres", "redis", "keycloak"):
    assert "healthcheck" in services[service_name], f"{service_name} has no healthcheck"

for one_shot in ("migrate", "bootstrap"):
    assert services[one_shot]["restart"] == "no"
PY

[[ -f apps/api/src/main.ts ]] || fail "apps/api/src/main.ts is missing"
[[ -f apps/api/src/worker.ts ]] || fail "apps/api/src/worker.ts is missing"
[[ -f apps/api/src/bootstrap.ts ]] || fail "apps/api/src/bootstrap.ts is missing"
[[ -f apps/api/prisma/migrations/202608090001_initial/migration.sql ]] \
  || fail "initial Prisma migration is missing"

printf '%s\n' 'infra tests passed'
