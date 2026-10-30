FROM node:24-bookworm-slim
WORKDIR /app
RUN mkdir -p /state /source && chown node:node /state
COPY --chown=node:node package.json config.mjs core.mjs app.mjs server.mjs setup.mjs ./
ENV NODE_ENV=production HOST=0.0.0.0 PORT=19581
USER node:node
EXPOSE 19581
CMD ["node", "server.mjs"]
