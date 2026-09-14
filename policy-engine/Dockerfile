FROM gcc:15.2.0-bookworm@sha256:9ca91b05c7b07d2979f16413e8b2cd6ec8a7c80ffca4121ccab0aeba33f90460 AS build
WORKDIR /src
COPY Makefile ./
COPY include ./include
COPY third_party ./third_party
COPY src ./src
RUN make release \
    && strip build/policy_cli

FROM node:24.14.0-bookworm-slim@sha256:d8e448a56fc63242f70026718378bd4b00f8c82e78d20eefb199224a4d8e33d8 AS runtime

WORKDIR /app
COPY --from=build /src/build/policy_cli /app/policy_cli
COPY --chown=node:node server.mjs /app/server.mjs
COPY --chown=node:node config /app/config
ENV NODE_ENV=production \
    PORT=8080 \
    POLICY_BINARY=/app/policy_cli \
    POLICY_CONFIG=/app/config/policy.json
USER node
EXPOSE 8080
HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=5 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:8080/healthz').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"]
CMD ["node", "/app/server.mjs"]
