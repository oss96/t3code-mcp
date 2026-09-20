# syntax=docker/dockerfile:1
FROM oven/bun:1.4.2-slim@sha256:cb3bbbb08e13a4a2ff400f24c7a2a1d5efa83f6ef8544d52d95a519631e2fc61 AS base
WORKDIR /app

FROM base AS dependencies
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production --ignore-scripts

FROM base AS runtime
LABEL org.opencontainers.image.source="https://github.com/daniel100097/t3code-mcp" \
      org.opencontainers.image.description="MCP server for T3 Code with stdio, Streamable HTTP, and SSE transports" \
      org.opencontainers.image.licenses="MIT"

ENV NODE_ENV=production \
    T3CODE_MCP_HOST=0.0.0.0 \
    T3CODE_MCP_CREDENTIALS=/data/credentials.json

RUN mkdir -p /data && chown bun:bun /data
COPY --from=dependencies --chown=bun:bun /app/node_modules ./node_modules
COPY --chown=bun:bun package.json LICENSE ./
COPY --chown=bun:bun src ./src

USER bun
EXPOSE 3001
ENTRYPOINT ["bun", "run", "src/cli.ts"]
CMD ["serve"]
