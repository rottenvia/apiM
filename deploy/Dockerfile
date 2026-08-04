# Build in one stage, run in a smaller one, so the image doesn't ship the
# toolchain and source alongside the app.

FROM node:22-alpine AS builder
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY . .

# Next needs these present at build time. Real values are supplied at runtime;
# these only satisfy the build.
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build

FROM node:22-alpine AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1

# Run as a non-root user, so a container escape lands somewhere unprivileged.
RUN addgroup -g 1001 -S nodejs && adduser -S nextjs -u 1001

COPY --from=builder /app/package.json /app/package-lock.json ./
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/.next ./.next
COPY --from=builder /app/next.config.ts ./
# No `public` directory in this project; add a COPY for it if one is created.

# The data directory is a mounted volume; it must be writable by the app user.
RUN mkdir -p /app/data && chown -R nextjs:nodejs /app/data

USER nextjs
EXPOSE 3000

CMD ["npm", "run", "start"]
