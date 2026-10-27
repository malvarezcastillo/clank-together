FROM docker:29-cli AS docker-cli
FROM node:24-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends git binutils ca-certificates && rm -rf /var/lib/apt/lists/*
COPY --from=docker-cli /usr/local/bin/docker /usr/local/bin/docker
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts
COPY src ./src
COPY ghidra_scripts ./ghidra_scripts
COPY template ./template
ENV NODE_ENV=production
ENTRYPOINT ["node", "src/server/cli.js"]
