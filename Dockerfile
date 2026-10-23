FROM node:24-alpine
RUN apk add --no-cache tzdata su-exec
ENV TZ=Europe/Paris NODE_ENV=production NODE_NO_WARNINGS=1 DATA_DIR=/app/data BRANDING_DIR=/app/branding HOST_DIR=/app/host
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev 2>/dev/null || npm install --omit=dev && npm cache clean --force
COPY server ./server
COPY public ./public
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod 755 /usr/local/bin/docker-entrypoint.sh && mkdir -p /app/data && chown node:node /app/data
# Démarre en root uniquement pour régler les droits de ./data, puis tourne sous « node »
ENTRYPOINT ["docker-entrypoint.sh"]
EXPOSE 3000
HEALTHCHECK --interval=60s --timeout=5s --start-period=20s CMD wget -qO- http://127.0.0.1:3000/api/health >/dev/null || exit 1
CMD ["node", "server/server.js"]
