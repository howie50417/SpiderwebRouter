#!/bin/bash
set -euo pipefail

load_secret() {
  local variable_name="$1"
  local file_variable_name="${variable_name}_FILE"
  local file_path="${!file_variable_name:-}"

  if [[ -z "$file_path" || ! -r "$file_path" ]]; then
    echo "Required secret file for ${variable_name} is not readable." >&2
    exit 1
  fi

  local secret_value
  secret_value="$(<"$file_path")"
  if [[ -z "$secret_value" ]]; then
    echo "Required secret ${variable_name} is empty." >&2
    exit 1
  fi
  export "${variable_name}=${secret_value}"
}

load_secret KC_DB_PASSWORD
load_secret KC_BOOTSTRAP_ADMIN_PASSWORD
load_secret KC_CLIENT_SECRET

exec /opt/keycloak/bin/kc.sh start --optimized --import-realm
