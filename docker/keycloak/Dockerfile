FROM quay.io/keycloak/keycloak:26.7.0 AS builder

ENV KC_DB=postgres \
    KC_HEALTH_ENABLED=true \
    KC_METRICS_ENABLED=true
RUN /opt/keycloak/bin/kc.sh build

FROM quay.io/keycloak/keycloak:26.7.0

COPY --from=builder /opt/keycloak/ /opt/keycloak/
COPY docker/keycloak/realm-export.json /opt/keycloak/data/import/spiderwebrouter-realm.json
COPY docker/keycloak/entrypoint.sh /opt/keycloak/bin/spiderwebrouter-entrypoint.sh

USER root
RUN chmod 0755 /opt/keycloak/bin/spiderwebrouter-entrypoint.sh \
    && chown -R 1000:0 /opt/keycloak/data
USER 1000

ENTRYPOINT ["/opt/keycloak/bin/spiderwebrouter-entrypoint.sh"]
