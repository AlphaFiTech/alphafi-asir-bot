FROM node:22-alpine

WORKDIR /app

COPY package*.json ./
RUN npm ci --production

COPY bot.ts ./

USER node

CMD ["node_modules/.bin/tsx", "bot.ts"]
