FROM node:24-bookworm-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY --chown=node:node package.json hosted-server.mjs hosted-services.mjs index.html styles.css ./
COPY --chown=node:node LICENSE THIRD_PARTY_NOTICES.md ./
COPY --chown=node:node licenses/ ./licenses/
COPY --chown=node:node js/ ./js/
COPY --chown=node:node css/ ./css/
COPY --chown=node:node wasm/ ./wasm/
COPY --chown=node:node assets/ ./assets/

ENV NODE_ENV=production HOST=0.0.0.0 PORT=8765
USER node
EXPOSE 8765
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:8765/api/health',{headers:{Host:new URL(process.env.PUBLIC_ORIGIN).host}}).then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
CMD ["node", "hosted-server.mjs"]
