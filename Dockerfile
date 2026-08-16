# Co-Engram MCP server (stdio) — container image for MCP registries
# (Glama and similar directories verify that the server starts and answers
# MCP introspection; this image runs the npm-distributed stdio server).
#
# Local smoke test:
#   docker build -t co-engram-mcp .
#   docker run -i --rm co-engram-mcp <<'EOF'
#   {"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"probe","version":"0.0.0"}}}
#   {"jsonrpc":"2.0","method":"notifications/initialized"}
#   {"jsonrpc":"2.0","id":2,"method":"tools/list"}
#   EOF
#
# The server auto-creates an empty dataRoot under CO_ENGRAM_HOME on first
# start; mount a volume at /data to persist memories across restarts.

FROM node:22-slim

RUN npm install -g @co-engram/claude-code

# Isolated bootstrap home (dataRoot pointer lives under $HOME/.co-engram)
ENV HOME=/data
VOLUME /data

# stdio MCP server: JSON-RPC over stdin/stdout
ENTRYPOINT ["co-engram-mcp"]
