FROM docker:29-cli AS docker-cli
FROM eclipse-temurin:25-jdk AS jdk
FROM node:24-bookworm-slim AS ghidra
ARG GHIDRA_URL=https://github.com/NationalSecurityAgency/ghidra/releases/download/Ghidra_12.2_build/ghidra_12.2_PUBLIC_20261016.zip
ARG GHIDRA_SHA256=2c2cd776db3c1f6a097ba418922378ac3649cadd5e844a6f5f088ae628a7be67
RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates unzip && rm -rf /var/lib/apt/lists/*
RUN curl -fsSL "$GHIDRA_URL" -o /tmp/ghidra.zip && echo "$GHIDRA_SHA256  /tmp/ghidra.zip" | sha256sum -c - && mkdir -p /opt/ghidra && unzip -q /tmp/ghidra.zip -d /opt/ghidra && rm /tmp/ghidra.zip

FROM node:24-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends git binutils ca-certificates fontconfig && rm -rf /var/lib/apt/lists/*
COPY --from=docker-cli /usr/local/bin/docker /usr/local/bin/docker
COPY --from=jdk /opt/java/openjdk /opt/java/openjdk
COPY --from=ghidra /opt/ghidra /opt/ghidra
ENV JAVA_HOME=/opt/java/openjdk
ENV PATH=/opt/java/openjdk/bin:$PATH
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts
COPY src ./src
COPY ghidra_scripts ./ghidra_scripts
COPY template ./template
ENV NODE_ENV=production
ENTRYPOINT ["node", "src/server/cli.js"]
