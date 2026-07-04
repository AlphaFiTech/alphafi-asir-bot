FROM node:22-alpine

LABEL org.opencontainers.image.source="https://github.com/AlphaFiTech/alphafi-betterstack" \
      org.opencontainers.image.description="AlphaFi Security and Incident Response (ASIR) Bot" \
      org.opencontainers.image.licenses="ISC"

WORKDIR /app

COPY alphafi-betterstack/package*.json ./
RUN npm ci --production

COPY alphafi-betterstack/bot.ts ./

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD kill -0 1 || exit 1

USER node

CMD ["node_modules/.bin/tsx", "bot.ts"]
