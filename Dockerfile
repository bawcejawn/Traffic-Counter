FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production \
    DB_PATH=/data/traffic.db \
    PORT=8080
COPY package.json ./
COPY bin ./bin
COPY src ./src
COPY public ./public
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME /data
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://127.0.0.1:8080/healthz || exit 1
CMD ["node", "bin/traffic-counter.js", "serve"]
