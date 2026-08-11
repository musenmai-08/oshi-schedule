# syntax=docker/dockerfile:1.7

FROM node:22.23.1-bookworm-slim AS workspace

ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
WORKDIR /workspace

RUN apt-get update \
    && apt-get install --yes --no-install-recommends ca-certificates openssl \
    && rm -rf /var/lib/apt/lists/*
RUN corepack enable && corepack prepare pnpm@9.15.9 --activate

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml turbo.json prisma.config.ts ./
COPY apps/api/package.json apps/api/package.json
COPY apps/worker/package.json apps/worker/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/eslint-config/package.json packages/eslint-config/package.json
COPY packages/shared/package.json packages/shared/package.json
COPY packages/typescript-config/package.json packages/typescript-config/package.json
COPY prisma/schema.prisma prisma/schema.prisma

RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile

COPY apps/api apps/api
COPY apps/worker apps/worker
COPY packages packages
COPY prisma prisma

RUN pnpm --filter @oshi-schedule/shared build \
    && pnpm --filter @oshi-schedule/api build \
    && pnpm --filter @oshi-schedule/worker build \
    && pnpm --filter @oshi-schedule/api deploy --prod /output/api

FROM node:22.23.1-bookworm-slim AS runtime

ENV NODE_ENV=production
ENV PORT=4000
WORKDIR /opt/oshi-schedule

RUN apt-get update \
    && apt-get install --yes --no-install-recommends ca-certificates openssl \
    && rm -rf /var/lib/apt/lists/*

RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
    && rm -f /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack \
        /usr/local/bin/pnpm /usr/local/bin/pnpx /usr/local/bin/yarn /usr/local/bin/yarnpkg

ADD --chown=root:root https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem \
    /etc/ssl/certs/aws-rds-global-bundle.pem

COPY --from=workspace --chown=node:node /output/api ./api
COPY --from=workspace --chown=node:node /workspace/apps/worker/dist ./worker/dist
COPY --from=workspace --chown=node:node /workspace/prisma ./prisma
COPY --chown=node:node docker/entrypoint.sh ./entrypoint.sh
RUN mkdir -p ./api/node_modules/@oshi-schedule \
    && ln -s ../api/node_modules ./worker/node_modules \
    && ln -s ../.. ./api/node_modules/@oshi-schedule/api \
    && chmod 0555 ./entrypoint.sh

USER node
EXPOSE 4000
STOPSIGNAL SIGTERM
ENTRYPOINT ["/opt/oshi-schedule/entrypoint.sh"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:4000/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"]

CMD ["node", "api/dist/server.js"]
