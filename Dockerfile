# syntax=docker/dockerfile:1.7@sha256:a57df69d0ea827fb7266491f2813635de6f17269be881f696fbfdf2d83dda33e
ARG NODE_IMAGE=node:22.23.0-bookworm-slim@sha256:d9f850096136edbc402debdd8729579a288aac64574ada0ff4db26b6ae58b0b2

FROM ${NODE_IMAGE} AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build --chown=node:node /app/package.json /app/package-lock.json ./
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
RUN install -d -o node -g node /var/lib/klaus-agent /var/lib/klaus-agent-auth

USER node
VOLUME ["/var/lib/klaus-agent", "/var/lib/klaus-agent-auth"]
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s --start-period=15s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:8080/live').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"]
ENTRYPOINT ["node", "--experimental-sqlite", "dist/src/cli.js"]
CMD ["--config", "/etc/klaus-agent/config.yaml"]

FROM runtime AS verification
COPY --chown=node:node examples/config.container-smoke.yaml /tmp/klaus-agent-config.yaml
RUN node --experimental-sqlite dist/src/runtime/container-smoke.js /tmp/klaus-agent-config.yaml

FROM runtime AS final
