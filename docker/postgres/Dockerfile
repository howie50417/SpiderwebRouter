FROM postgres:17.10-alpine3.24

COPY docker/postgres/init-databases.sh /docker-entrypoint-initdb.d/10-init-databases.sh
RUN chmod 0755 /docker-entrypoint-initdb.d/10-init-databases.sh
