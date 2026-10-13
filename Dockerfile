# BEAM — no dependencies, no build step, no database.
# The image is just Node + the static app + the rendezvous server.
FROM node:20-alpine

WORKDIR /app

# Only what the server actually needs.
COPY server.js ./
COPY public ./public

ENV PORT=8787
EXPOSE 8787

# Run unprivileged; the server never writes to disk.
USER node

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s \
  CMD wget -qO- "http://127.0.0.1:${PORT}/api/config" >/dev/null 2>&1 || exit 1

CMD ["node", "server.js"]
