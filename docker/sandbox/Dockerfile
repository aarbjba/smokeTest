# syntax=docker/dockerfile:1.7
FROM node:22-slim

ENV DEBIAN_FRONTEND=noninteractive \
    NPM_CONFIG_PREFIX=/usr/local/share/npm-global \
    PATH=/usr/local/share/npm-global/bin:$PATH \
    DEVCONTAINER=true \
    CLAUDE_CODE_USE_BEDROCK=0 \
    CLAUDE_CODE_USE_VERTEX=0 \
    HOME=/home/node \
    GIT_TERMINAL_PROMPT=0

RUN apt-get update && apt-get install -y --no-install-recommends \
      git ca-certificates curl jq sudo iptables ipset dnsutils iproute2 \
 && install -m 0755 -d /etc/apt/keyrings \
 && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
      | tee /etc/apt/keyrings/githubcli-archive-keyring.gpg >/dev/null \
 && chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg \
 && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
      > /etc/apt/sources.list.d/github-cli.list \
 && apt-get update && apt-get install -y --no-install-recommends gh \
 && apt-get clean && rm -rf /var/lib/apt/lists/*

ARG CLAUDE_CODE_VERSION=latest
RUN mkdir -p /usr/local/share/npm-global \
 && chown -R node:node /usr/local/share/npm-global \
 && npm install -g @anthropic-ai/claude-code@${CLAUDE_CODE_VERSION} \
 && npm cache clean --force

COPY init-firewall.sh      /usr/local/bin/init-firewall.sh
COPY agent-entrypoint.sh   /usr/local/bin/agent-entrypoint.sh
RUN chmod +x /usr/local/bin/init-firewall.sh /usr/local/bin/agent-entrypoint.sh \
 && echo "node ALL=(root) NOPASSWD: /usr/local/bin/init-firewall.sh" \
      > /etc/sudoers.d/node-firewall \
 && chmod 0440 /etc/sudoers.d/node-firewall \
 && mkdir -p /home/node/.claude \
 && chown -R node:node /home/node

USER node
WORKDIR /workspace

ENTRYPOINT ["/bin/bash","-lc","sudo /usr/local/bin/init-firewall.sh && exec /usr/local/bin/agent-entrypoint.sh"]
