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
assert realm["loginTheme"] == "spiderwebrouter"
assert realm["registrationAllowed"] is False
assert realm["resetPasswordAllowed"] is False
assert realm["internationalizationEnabled"] is True
assert realm["supportedLocales"] == ["zh-TW", "en"]
assert realm["defaultLocale"] == "zh-TW"
assert realm["accessTokenLifespan"] == 300
assert realm["ssoSessionIdleTimeout"] == 604800
assert realm["ssoSessionMaxLifespan"] == 2592000
assert realm["clientSessionIdleTimeout"] == 604800
assert realm["clientSessionMaxLifespan"] == 2592000
totp = next(action for action in realm["requiredActions"] if action["alias"] == "CONFIGURE_TOTP")
assert totp["enabled"] is True
assert totp["defaultAction"] is False
PY

[[ -f favicon.ico ]] || fail "canonical favicon.ico is missing"
grep -Fq \
  'COPY favicon.ico /opt/keycloak/themes/spiderwebrouter/login/resources/img/favicon.ico' \
  docker/keycloak/Dockerfile \
  || fail "Keycloak image does not install the canonical favicon"

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

api_service_names = ("api", "worker", "migrate", "bootstrap")
assert len({services[name]["image"] for name in api_service_names}) == 1
assert "build" in services["migrate"]
for service_name in ("api", "worker", "bootstrap"):
    assert "build" not in services[service_name]
    assert services[service_name]["pull_policy"] == "never"

for service_name in ("api", "worker", "migrate", "bootstrap"):
    environment = services[service_name]["environment"]
    assert str(environment["AUTH_SESSION_IDLE_SECONDS"]) == "604800"
    assert str(environment["AUTH_SESSION_MAX_SECONDS"]) == "2592000"
PY

[[ -f apps/api/src/main.ts ]] || fail "apps/api/src/main.ts is missing"
[[ -f apps/api/src/worker.ts ]] || fail "apps/api/src/worker.ts is missing"
[[ -f apps/api/src/bootstrap.ts ]] || fail "apps/api/src/bootstrap.ts is missing"
[[ -f apps/api/prisma/migrations/202608090001_initial/migration.sql ]] \
  || fail "initial Prisma migration is missing"
grep -q '^    KC_HTTP_RELATIVE_PATH=/auth \\' docker/keycloak/Dockerfile \
  || fail "Keycloak optimized build is missing KC_HTTP_RELATIVE_PATH=/auth"
grep -q '^    KC_HTTP_MANAGEMENT_RELATIVE_PATH=/' docker/keycloak/Dockerfile \
  || fail "Keycloak optimized build is missing KC_HTTP_MANAGEMENT_RELATIVE_PATH=/"
grep -Fq 'COPY docker/keycloak/themes/spiderwebrouter /opt/keycloak/themes/spiderwebrouter' docker/keycloak/Dockerfile \
  || fail "Keycloak image omits the SpiderwebRouter login theme"
grep -Fq 'COPY apps/web/public/logo.png /opt/keycloak/themes/spiderwebrouter/login/resources/img/logo.png' docker/keycloak/Dockerfile \
  || fail "Keycloak theme does not consume the canonical logo"
grep -Fq 'COPY apps/web/public/fonts /opt/keycloak/themes/spiderwebrouter/login/resources/fonts' docker/keycloak/Dockerfile \
  || fail "Keycloak theme does not consume the canonical login fonts"
[[ -f docker/keycloak/themes/spiderwebrouter/login/theme.properties ]] \
  || fail "Keycloak login theme properties are missing"
[[ -f docker/keycloak/themes/spiderwebrouter/login/resources/css/spiderwebrouter-v2.css ]] \
  || fail "Keycloak versioned login theme stylesheet is missing"
[[ -f docker/keycloak/themes/spiderwebrouter/login/resources/css/layout-v2.css ]] \
  || fail "Keycloak login layout cascade guard is missing"
[[ -f apps/web/public/logo.png ]] || fail "canonical logo.png is missing"
[[ -f apps/web/public/fonts/NotoSansTC-Variable.woff2 ]] || fail "Noto Sans TC login font is missing"
[[ -f apps/web/public/fonts/JetBrainsMono-Variable.woff2 ]] || fail "JetBrains Mono login font is missing"
grep -Fq 'styles=css/styles.css css/spiderwebrouter-v2.css css/layout-v2.css' docker/keycloak/themes/spiderwebrouter/login/theme.properties \
  || fail "Keycloak custom theme does not load the structural, cache-busted brand, and layout styles in order"
grep -Fq 'radial-gradient(80% 60% at 50% 12%, #0d3a35 0%, #071e1c 45%, #030c0b 100%)' docker/keycloak/themes/spiderwebrouter/login/resources/css/spiderwebrouter-v2.css \
  || fail "Keycloak theme does not use the approved 2b radial background"
grep -Fq "url('../fonts/NotoSansTC-Variable.woff2')" docker/keycloak/themes/spiderwebrouter/login/resources/css/spiderwebrouter-v2.css \
  || fail "Keycloak theme does not load the approved Noto Sans TC font"
grep -Fq 'repeating-linear-gradient(118deg' docker/keycloak/themes/spiderwebrouter/login/resources/css/spiderwebrouter-v2.css \
  || fail "Keycloak theme is missing the approved 2b line texture"
grep -Fq -- '--swr-login-card-width: 35rem' docker/keycloak/themes/spiderwebrouter/login/resources/css/spiderwebrouter-v2.css \
  || fail "Keycloak login card is not expanded to the approved 560px width"
grep -Fq 'padding: 0 !important' docker/keycloak/themes/spiderwebrouter/login/resources/css/layout-v2.css \
  || fail "Keycloak layout does not neutralize PatternFly desktop container padding"
grep -Fq 'position: fixed !important' docker/keycloak/themes/spiderwebrouter/login/resources/css/layout-v2.css \
  || fail "Keycloak locale selector can still consume title width"
grep -Fq 'grid-template-columns: minmax(0, 1fr) !important' docker/keycloak/themes/spiderwebrouter/login/resources/css/layout-v2.css \
  || fail "Keycloak locale-enabled header can still split into two columns"
grep -Fq 'min-width: 8rem' docker/keycloak/themes/spiderwebrouter/login/resources/css/layout-v2.css \
  || fail "Keycloak desktop locale selector can still truncate its label"
grep -Fq 'background: linear-gradient(90deg, #2fd9b4, #0f766e)' docker/keycloak/themes/spiderwebrouter/login/resources/css/spiderwebrouter-v2.css \
  || fail "Keycloak card is missing the approved teal accent bar"

! grep -Fq 'COPY . .' docker/api/Dockerfile \
  || fail "API dependency cache is invalidated by a whole-repository COPY"
grep -Fq -- '--mount=type=cache,id=pnpm-store,target=/pnpm/store' docker/api/Dockerfile \
  || fail "API build has no persistent pnpm store cache"
grep -Fq -- '--filter @spiderwebrouter/api...' docker/api/Dockerfile \
  || fail "API dependencies are not installed with a workspace filter"
grep -Fq 'install --frozen-lockfile' docker/api/Dockerfile \
  || fail "API dependency install does not enforce the lockfile"
grep -Fq -- '--prod deploy --legacy /prod/apps/api' docker/api/Dockerfile \
  || fail "API runtime is not built from a production-only deploy bundle"
! grep -Fq '/app /app' docker/api/Dockerfile \
  || fail "API runtime still copies the whole monorepo"

! grep -Fq 'COPY . .' docker/edge/Dockerfile \
  || fail "Web dependency cache is invalidated by a whole-repository COPY"
grep -Fq -- '--mount=type=cache,id=pnpm-store,target=/pnpm/store' docker/edge/Dockerfile \
  || fail "Web build has no persistent pnpm store cache"
grep -Fq -- '--filter @spiderwebrouter/web...' docker/edge/Dockerfile \
  || fail "Web dependencies are not installed with a workspace filter"
grep -Fq 'COPY apps/web ./apps/web' docker/edge/Dockerfile \
  || fail "Web source is not copied independently from backend source"

python3 - "${REPO_ROOT}/apps/api/package.json" <<'PY'
import json
import pathlib
import sys

package = json.loads(pathlib.Path(sys.argv[1]).read_text(encoding="utf-8"))
assert "prisma" in package["dependencies"]
assert "prisma" not in package["devDependencies"]
assert {"dist", "prisma"}.issubset(package["files"])
PY

printf '%s\n' 'infra tests passed'
