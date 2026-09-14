FROM gcc:15.2.0-bookworm@sha256:9ca91b05c7b07d2979f16413e8b2cd6ec8a7c80ffca4121ccab0aeba33f90460 AS policy-build
WORKDIR /src/policy-engine
COPY policy-engine/Makefile ./
COPY policy-engine/include/config.h policy-engine/include/lead.h policy-engine/include/lead_router.h policy-engine/include/lead_rules.h ./include/
COPY policy-engine/src/config.c policy-engine/src/lead.c policy-engine/src/lead_router.c policy-engine/src/lead_rules.c policy-engine/src/policy_cli.c ./src/
COPY policy-engine/third_party/cJSON.c policy-engine/third_party/cJSON.h ./third_party/
RUN make release \
      CFLAGS='-std=c11 -O2 -Wall -Wextra -Wpedantic -Werror -fPIE -fstack-protector-strong -D_FORTIFY_SOURCE=3 -ffile-prefix-map=/src=. -fdebug-prefix-map=/src=.' \
      LDFLAGS='-pie -Wl,-z,relro,-z,now,-z,noexecstack,--build-id=none' \
    && strip --strip-all build/policy_cli \
    && test "$(find build -type f | wc -l)" -eq 1

FROM node:24.14.0-bookworm-slim@sha256:d8e448a56fc63242f70026718378bd4b00f8c82e78d20eefb199224a4d8e33d8 AS runtime
WORKDIR /app
COPY --from=policy-build --chown=10001:10001 /src/policy-engine/build/policy_cli /app/policy_cli
COPY --chown=10001:10001 policy-engine/config/policy.json /app/config/policy.json
COPY --chown=10001:10001 companion/server.mjs /app/server.mjs
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8080 \
    POLICY_BINARY=/app/policy_cli \
    POLICY_CONFIG=/app/config/policy.json
USER 10001:10001
EXPOSE 8080
HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=5 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:8080/readyz').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"]
CMD ["node", "/app/server.mjs"]
