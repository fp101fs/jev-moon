FROM oven/bun:1.2-slim
WORKDIR /app

# Install dependencies
COPY package.json bun.lock* ./
RUN bun install --production

# Copy application source code and web assets
COPY tsconfig.json ./
COPY src/ ./src/
COPY public/ ./public/
# Seed state lives outside /app/data so a mounted volume doesn't hide it;
# entrypoint.sh copies it into the volume on first boot.
COPY data/bot-live/ ./seed/bot-live/
COPY entrypoint.sh ./

RUN chmod +x entrypoint.sh

ENV NODE_ENV=production
ENV PORT=3333

EXPOSE 3333

CMD ["./entrypoint.sh"]
