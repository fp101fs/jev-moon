FROM oven/bun:1.2-slim
WORKDIR /app

# Install dependencies
COPY package.json bun.lock* ./
RUN bun install --production

# Copy application source code and web assets
COPY tsconfig.json ./
COPY src/ ./src/
COPY public/ ./public/
COPY data/bot-live/ ./data/bot-live/
COPY entrypoint.sh ./

RUN chmod +x entrypoint.sh

ENV NODE_ENV=production
ENV PORT=3333

EXPOSE 3333

CMD ["./entrypoint.sh"]
