FROM node:24-alpine
RUN apk add --no-cache tzdata
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY server.mjs ./
COPY src ./src
COPY public ./public
COPY scripts ./scripts
COPY downloads ./downloads
RUN node scripts/precompress.mjs
ENV NODE_ENV=production
# Named volumes mounted here inherit this ownership on first use.
RUN mkdir -p /data /backup && chown node:node /data /backup && chmod 700 /data /backup
USER node
EXPOSE 8800
CMD ["node", "--disable-warning=ExperimentalWarning", "server.mjs"]
