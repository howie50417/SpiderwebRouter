#!/bin/sh
set -eu

secret_file="/run/secrets/redis_password"
if [ ! -r "$secret_file" ]; then
  echo "Redis password secret is not readable." >&2
  exit 1
fi

redis_password="$(cat "$secret_file")"
if [ -z "$redis_password" ]; then
  echo "Redis password secret is empty." >&2
  exit 1
fi

umask 077
config_file="/tmp/spiderwebrouter-redis.conf"
{
  printf '%s\n' 'bind 0.0.0.0'
  printf '%s\n' 'protected-mode yes'
  printf '%s\n' 'port 6379'
  printf '%s\n' 'appendonly yes'
  printf '%s\n' 'appendfsync everysec'
  printf '%s\n' 'dir /data'
  printf 'requirepass %s\n' "$redis_password"
} > "$config_file"
unset redis_password

exec /usr/local/bin/docker-entrypoint.sh redis-server "$config_file"
