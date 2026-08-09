#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd -- "${SCRIPT_DIR}/.." && pwd)"
ENV_FILE="${REPO_ROOT}/.env"
ENV_TEMPLATE="${REPO_ROOT}/.env.example"
DEFAULT_SECRETS_DIR="${REPO_ROOT}/secrets"
TEMP_DIR=""
SECRET_NAMES=(
  postgres_password keycloak_db_password redis_password
  keycloak_admin_password keycloak_client_secret session_secret
  api_key_pepper provider_encryption_key initial_admin_password
)

cleanup() {
  if [[ -n "$TEMP_DIR" && -d "$TEMP_DIR" ]]; then
    rm -rf -- "$TEMP_DIR"
  fi
}

die() {
  printf 'Error: %s\n' "$1" >&2
  exit 1
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || die "Required command '$1' was not found."
}

check_docker() {
  require_command docker
  docker compose version >/dev/null 2>&1 || die "Docker Compose v2 is required."
  docker info >/dev/null 2>&1 || die "Docker is installed but its daemon is not running."
}

check_port_80() {
  if command -v ss >/dev/null 2>&1; then
    if ss -H -ltn 2>/dev/null | awk '{print $4}' | grep -Eq '(^|:)80$'; then
      die "TCP port 80 is already in use."
    fi
    return
  fi

  if command -v lsof >/dev/null 2>&1; then
    if lsof -nP -iTCP:80 -sTCP:LISTEN >/dev/null 2>&1; then
      die "TCP port 80 is already in use."
    fi
    return
  fi

  if command -v netstat >/dev/null 2>&1; then
    if netstat -an 2>/dev/null | grep -E '[:.]80[[:space:]].*LISTEN' >/dev/null 2>&1; then
      die "TCP port 80 is already in use."
    fi
    return
  fi

  die "Could not verify TCP port 80 because ss, lsof, and netstat are unavailable."
}

env_value() {
  local key="$1"
  local value
  value="$(awk -F= -v wanted="$key" '$1 == wanted { sub(/^[^=]*=/, ""); print; exit }' "$ENV_FILE")"
  printf '%s' "$value"
}

validate_public_url() {
  local value="$1"
  [[ "$value" =~ ^https://[^/?#[:space:]]+$ ]] \
    || die "PUBLIC_BASE_URL must be an HTTPS origin without a path, query, fragment, or trailing slash."
}

validate_proxy_cidrs() {
  local value="$1"
  [[ "$value" == "private_ranges" || "$value" =~ ^[0-9A-Fa-f.:/[:space:]]+$ ]] \
    || die "TRUSTED_PROXY_CIDRS must be 'private_ranges' or a space-separated CIDR list."
}

validate_session_timeouts() {
  local idle_seconds="$1"
  local max_seconds="$2"
  [[ "$idle_seconds" =~ ^[1-9][0-9]*$ && "$max_seconds" =~ ^[1-9][0-9]*$ ]] \
    || die "AUTH_SESSION_IDLE_SECONDS and AUTH_SESSION_MAX_SECONDS must be positive integers."
  (( idle_seconds <= max_seconds )) \
    || die "AUTH_SESSION_IDLE_SECONDS must not exceed AUTH_SESSION_MAX_SECONDS."
}

resolve_secrets_dir() {
  local configured="$1"
  if [[ "$configured" = /* ]]; then
    printf '%s' "$configured"
  else
    printf '%s/%s' "$REPO_ROOT" "${configured#./}"
  fi
}

validated_secrets_dir() {
  local configured="$1"
  local candidate
  candidate="$(resolve_secrets_dir "$configured")"

  [[ -d "$candidate" && ! -L "$candidate" ]] \
    || die "Secrets directory ${candidate} must be a real directory, not a symlink."

  local canonical
  canonical="$(cd -- "$candidate" && pwd -P)"
  [[ "$canonical" != "/" && "$canonical" != "$REPO_ROOT" ]] \
    || die "Refusing to use a filesystem or repository root as SECRETS_DIR."

  local secret_name secret_path
  for secret_name in "${SECRET_NAMES[@]}"; do
    secret_path="${canonical}/${secret_name}"
    [[ -f "$secret_path" && ! -L "$secret_path" && -s "$secret_path" ]] \
      || die "Required secret ${secret_path} must be a non-empty regular file, not a symlink."
  done

  printf '%s' "$canonical"
}

repair_secret_permissions() {
  local environment_file="$1"
  local secrets_dir="$2"
  local secret_name

  # Local Docker Compose secrets are bind mounts and preserve source modes.
  # The 0700 directory protects the files on the host; 0644 lets arbitrary
  # non-root container UIDs read only the individually mounted secret files.
  chmod 600 -- "$environment_file"
  chmod 700 -- "$secrets_dir"
  for secret_name in "${SECRET_NAMES[@]}"; do
    chmod 644 -- "${secrets_dir}/${secret_name}"
  done
}

validate_existing_environment() {
  local required_keys=(
    PUBLIC_BASE_URL TRUSTED_PROXY_CIDRS INITIAL_ADMIN_EMAIL SECRETS_DIR
    POSTGRES_USER POSTGRES_DB KEYCLOAK_DB_USER KEYCLOAK_DB_NAME
    KEYCLOAK_ADMIN_USERNAME
  )
  local key value

  for key in "${required_keys[@]}"; do
    value="$(env_value "$key")"
    [[ -n "$value" ]] || die ".env is missing required value ${key}."
    [[ "$value" != __*__ ]] || die ".env still contains the placeholder for ${key}."
  done

  validate_public_url "$(env_value PUBLIC_BASE_URL)"
  validate_proxy_cidrs "$(env_value TRUSTED_PROXY_CIDRS)"
  local session_idle session_max
  session_idle="$(env_value AUTH_SESSION_IDLE_SECONDS)"
  session_max="$(env_value AUTH_SESSION_MAX_SECONDS)"
  if [[ -n "$session_idle" || -n "$session_max" ]]; then
    validate_session_timeouts "$session_idle" "$session_max"
  fi
  [[ "$(env_value INITIAL_ADMIN_EMAIL)" =~ ^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$ ]] \
    || die "INITIAL_ADMIN_EMAIL is not a valid email address."

  validated_secrets_dir "$(env_value SECRETS_DIR)"
}

random_hex() {
  local byte_count="$1"
  od -An -N "$byte_count" -tx1 /dev/urandom | tr -d '[:space:]'
}

write_environment_file() {
  local destination="$1"
  local public_base_url="$2"
  local trusted_proxy_cidrs="$3"
  local admin_email="$4"
  local line

  while IFS= read -r line || [[ -n "$line" ]]; do
    case "$line" in
      PUBLIC_BASE_URL=__PUBLIC_BASE_URL__)
        printf 'PUBLIC_BASE_URL=%s\n' "$public_base_url"
        ;;
      TRUSTED_PROXY_CIDRS=__TRUSTED_PROXY_CIDRS__)
        printf 'TRUSTED_PROXY_CIDRS=%s\n' "$trusted_proxy_cidrs"
        ;;
      INITIAL_ADMIN_EMAIL=__INITIAL_ADMIN_EMAIL__)
        printf 'INITIAL_ADMIN_EMAIL=%s\n' "$admin_email"
        ;;
      *)
        printf '%s\n' "$line"
        ;;
    esac
  done < "$ENV_TEMPLATE" > "$destination"
}

main() {
  trap cleanup EXIT
  cd "$REPO_ROOT"
  [[ -f "$ENV_TEMPLATE" ]] || die ".env.example was not found."

  if [[ -e "$ENV_FILE" ]]; then
    [[ -f "$ENV_FILE" && ! -L "$ENV_FILE" ]] \
      || die ".env must be a regular file, not a symlink."
    local existing_secrets_dir
    existing_secrets_dir="$(validate_existing_environment)"
    repair_secret_permissions "$ENV_FILE" "$existing_secrets_dir"
    check_docker
    printf '%s\n' 'docker compose up -d'
    return 0
  fi

  check_docker
  [[ ! -e "$DEFAULT_SECRETS_DIR" ]] \
    || die "The secrets directory already exists. Move it aside before initializing a new environment."
  check_port_80
  require_command od
  require_command awk
  require_command grep
  require_command mktemp

  local public_base_url trusted_proxy_cidrs initial_admin_email
  local initial_admin_password initial_admin_password_confirmation
  read -r -p 'Public HTTPS origin (for example https://ai.example.com): ' public_base_url
  public_base_url="${public_base_url%/}"
  validate_public_url "$public_base_url"

  read -r -p 'Trusted proxy CIDRs [private_ranges]: ' trusted_proxy_cidrs
  trusted_proxy_cidrs="${trusted_proxy_cidrs:-private_ranges}"
  validate_proxy_cidrs "$trusted_proxy_cidrs"

  read -r -p 'Initial super administrator email: ' initial_admin_email
  [[ "$initial_admin_email" =~ ^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$ ]] \
    || die "The super administrator email address is invalid."

  while true; do
    read -r -s -p 'Initial temporary administrator password (minimum 12 characters): ' initial_admin_password
    printf '\n'
    [[ ${#initial_admin_password} -ge 12 ]] || {
      printf '%s\n' 'Password must contain at least 12 characters.' >&2
      continue
    }
    read -r -s -p 'Confirm temporary administrator password: ' initial_admin_password_confirmation
    printf '\n'
    [[ "$initial_admin_password" == "$initial_admin_password_confirmation" ]] || {
      printf '%s\n' 'Passwords do not match.' >&2
      continue
    }
    unset initial_admin_password_confirmation
    break
  done

  TEMP_DIR="$(mktemp -d "${REPO_ROOT}/.init-env.XXXXXX")"
  mkdir -m 700 "${TEMP_DIR}/secrets"

  printf '%s' "$(random_hex 32)" > "${TEMP_DIR}/secrets/postgres_password"
  printf '%s' "$(random_hex 32)" > "${TEMP_DIR}/secrets/keycloak_db_password"
  printf '%s' "$(random_hex 32)" > "${TEMP_DIR}/secrets/redis_password"
  printf '%s' "$(random_hex 32)" > "${TEMP_DIR}/secrets/keycloak_admin_password"
  printf '%s' "$(random_hex 32)" > "${TEMP_DIR}/secrets/keycloak_client_secret"
  printf '%s' "$(random_hex 64)" > "${TEMP_DIR}/secrets/session_secret"
  printf '%s' "$(random_hex 32)" > "${TEMP_DIR}/secrets/api_key_pepper"
  printf '%s' "$(random_hex 32)" > "${TEMP_DIR}/secrets/provider_encryption_key"
  printf '%s' "$initial_admin_password" > "${TEMP_DIR}/secrets/initial_admin_password"
  unset initial_admin_password
  chmod 644 "${TEMP_DIR}/secrets/"*

  write_environment_file \
    "${TEMP_DIR}/.env" \
    "$public_base_url" \
    "$trusted_proxy_cidrs" \
    "$initial_admin_email"
  chmod 600 "${TEMP_DIR}/.env"

  mv -- "${TEMP_DIR}/secrets" "$DEFAULT_SECRETS_DIR"
  mv -- "${TEMP_DIR}/.env" "$ENV_FILE"
  rmdir -- "$TEMP_DIR"
  TEMP_DIR=""

  local created_secrets_dir
  created_secrets_dir="$(validate_existing_environment)"
  repair_secret_permissions "$ENV_FILE" "$created_secrets_dir"
  printf '%s\n' 'docker compose up -d'
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  main "$@"
fi
