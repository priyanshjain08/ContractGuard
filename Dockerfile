# UNVERIFIED: not built in the authoring environment.
FROM node:22-alpine AS runtime
RUN apk add --no-cache postgresql-client && corepack enable
WORKDIR /app
COPY . .
RUN pnpm install --frozen-lockfile=false && pnpm --filter @contractguard/db generate
ENV NODE_ENV=production
USER node
