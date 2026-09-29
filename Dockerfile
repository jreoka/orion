FROM node:20-slim
WORKDIR /app
# Build tools for native deps (better-sqlite3) when no prebuilt binary matches.
# Docker CLI (static binary) for `docker cp`/`docker exec` into agent sandboxes
# via the mounted /var/run/docker.sock.
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ curl ca-certificates \\\n  && curl -fsSL https://download.docker.com/linux/static/stable/x86_64/docker-28.0.0.tgz -o /tmp/docker.tgz \\\n  && tar -xzf /tmp/docker.tgz -C /tmp && mv /tmp/docker/docker /usr/local/bin/docker \\\n  && chmod +x /usr/local/bin/docker && rm -rf /tmp/docker.tgz /tmp/docker \\\n  && apt-get purge -y curl && apt-get autoremove -y \\\n  && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund
COPY src ./src
COPY public ./public
COPY sandbox ./sandbox
ENV NODE_ENV=production PORT=3000 DATA_DIR=/app/data
VOLUME ["/app/data"]
EXPOSE 3000
CMD ["node", "src/server.js"]
