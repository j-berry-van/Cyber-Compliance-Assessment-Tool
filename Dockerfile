# Multi-user (server mode) image: builds the React app with REACT_APP_SERVER_MODE=true and serves it
# plus the API from one Node process. See docs/SELF_HOSTING.md.
#
# Node 18 is kept on purpose: server/package.json pins better-sqlite3 ^11, the last major that supports Node 18
# (newer majors need Node 22+). If you move to a newer Node, move better-sqlite3 with it and re-test.
FROM node:18-bookworm AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
# INLINE_RUNTIME_CHUNK=false because the server's Content-Security-Policy forbids inline scripts.
ENV REACT_APP_SERVER_MODE=true INLINE_RUNTIME_CHUNK=false
RUN npm run build

FROM node:18-bookworm-slim
WORKDIR /app/server
COPY server/package*.json ./
RUN npm ci --omit=dev
COPY server/ ./
COPY --from=build /app/build /app/build
RUN mkdir -p /data && chown node:node /data
ENV MULTIUSER=true STATIC_DIR=/app/build DATA_DIR=/data PORT=4000
# Set COOKIE_SECURE=true (served over HTTPS) or TRUST_PROXY=true (behind a TLS-terminating proxy) at run time.
USER node
VOLUME /data
EXPOSE 4000
CMD ["node", "index.js"]
