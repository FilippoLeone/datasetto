# syntax=docker/dockerfile:1.7
# nginx + nginx-rtmp-module: RTMP ingest (OBS) remuxed to HLS, no transcoding.
# The stream module adds an RTMPS (TLS) front on 1936 that reuses Caddy's certificate.
FROM alpine:3.24 AS builder
ARG NGINX_VERSION=1.30.6
ARG RTMP_MODULE_REF=v1.2.2
RUN apk add --no-cache build-base ca-certificates git linux-headers openssl-dev pcre2-dev zlib-dev curl tar
WORKDIR /src
RUN curl -fsSL "https://nginx.org/download/nginx-${NGINX_VERSION}.tar.gz" | tar -xz \
 && git clone --depth 1 --branch "${RTMP_MODULE_REF}" https://github.com/arut/nginx-rtmp-module.git
WORKDIR /src/nginx-${NGINX_VERSION}
RUN ./configure \
      --prefix=/opt/nginx \
      --with-http_ssl_module \
      --with-http_stub_status_module \
      --with-stream \
      --with-stream_ssl_module \
      --add-module=/src/nginx-rtmp-module \
 && make -j"$(nproc)" \
 && make install \
 && rm -rf /opt/nginx/html /opt/nginx/logs/*

FROM alpine:3.24
RUN apk add --no-cache ca-certificates libcrypto3 libssl3 pcre2 zlib su-exec \
 && addgroup -S nginx && adduser -S -G nginx nginx
COPY --from=builder /opt/nginx /opt/nginx
COPY nginx.conf /etc/nginx/nginx.conf
COPY entrypoint.sh /entrypoint.sh
ENV PATH="/opt/nginx/sbin:$PATH"
# Validate the config at build time (the app hostname only resolves inside the Docker network),
# then remove the pid files the test run creates so they are not left root-owned.
RUN mkdir -p /etc/nginx/rtmps \
 && sed "s#http://app:4000#http://127.0.0.1:4000#g" /etc/nginx/nginx.conf > /tmp/nginx.test.conf \
 && nginx -t -c /tmp/nginx.test.conf -g "error_log stderr;" \
 && rm -f /tmp/nginx.test.conf /tmp/nginx.pid /opt/nginx/logs/nginx.pid
# The entrypoint starts as root only to copy Caddy's root-owned certificate into /etc/nginx/certs
# and write the RTMPS server block to /etc/nginx/rtmps, then runs nginx as the unprivileged nginx
# user: pid in its own logs dir, HLS in /tmp/hls (tmpfs), logs to stdout/stderr.
RUN chmod 0755 /entrypoint.sh \
 && mkdir -p /etc/nginx/certs /tmp/hls /opt/nginx/logs \
 && chown -R nginx:nginx /tmp/hls /opt/nginx/logs /opt/nginx/conf \
 && chgrp nginx /etc/nginx/certs && chmod 0750 /etc/nginx/certs
EXPOSE 1935 1936 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD wget -q --spider http://127.0.0.1:8080/health || exit 1
ENTRYPOINT ["/entrypoint.sh"]
CMD ["nginx", "-c", "/etc/nginx/nginx.conf", "-g", "daemon off;"]
