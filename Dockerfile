FROM node:22-alpine

# Set working directory
WORKDIR /app

# Copy package files and install production dependencies
COPY package*.json ./
RUN npm ci --production

# Copy application source code
COPY bot.js ./

# Run as non-root user for security
USER node

# Start the bot
CMD ["node", "bot.js"]
