FROM redis:8.2.8-alpine3.22

COPY docker/redis/entrypoint.sh /usr/local/bin/spiderwebrouter-redis-entrypoint.sh
RUN chmod 0755 /usr/local/bin/spiderwebrouter-redis-entrypoint.sh
ENTRYPOINT ["/usr/local/bin/spiderwebrouter-redis-entrypoint.sh"]
