# Orion agent VM: a full Linux box per user with node, python, and a real
# headless Chromium (via Playwright) for the browser tools.
FROM mcr.microsoft.com/playwright:v1.49.0-noble

# Lean on top of the Playwright base (node + chromium + playwright already
# there): just the scripting basics, plus the Docker CLI so the agent can
# use the host's Docker daemon (socket is mounted at run time; the daemon
# itself runs on the host, not in here).
#
# Python: pip is available; the agent installs what it needs with
# `pip install --user` (no root). Keep the base image lean — don't pre-install
# heavy stacks like torch/numpy here.
RUN apt-get update && apt-get install -y --no-install-recommends \
        python3 python3-pip python3-venv git curl jq docker.io sudo \
    && rm -rf /var/lib/apt/lists/* \
    && npm i -g playwright@1.49.0 \
    && docker --version

# The agent runs as non-root `agent`, but needs to install system packages.
# Give it passwordless sudo ONLY for apt-get/apt — not full root. The
# container's no-new-privileges:true prevents setuid escapes, so this is safe.
RUN echo "agent ALL=(root) NOPASSWD: /usr/bin/apt-get, /usr/bin/apt" > /etc/sudoers.d/agent-apt \
    && chmod 0440 /etc/sudoers.d/agent-apt \
    && visudo -c

ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    NODE_PATH=/usr/local/lib/node_modules:/usr/lib/node_modules

# The base image ships user `pwuser` (uid 1000); rename it to `agent` so the
# VM's user matches what the platform expects.
RUN usermod -l agent pwuser && groupmod -n agent pwuser \
    && usermod -d /home/agent -m agent \
    && mkdir -p /home/agent/workspace/.shots \
    && chown -R agent:agent /home/agent

COPY orion-browser.js /usr/local/bin/orion-browser
RUN chmod +x /usr/local/bin/orion-browser

USER agent
WORKDIR /home/agent/workspace

CMD ["sleep", "infinity"]
