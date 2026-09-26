# Orion agent VM: a full Linux box per user with node, python, and a real
# headless Chromium (via Playwright) for the browser tools.
FROM mcr.microsoft.com/playwright:v1.49.0-noble

# Lean on top of the Playwright base (node + chromium + playwright already
# there): just the scripting basics.
RUN apt-get update && apt-get install -y --no-install-recommends \
        python3 git curl jq \
    && rm -rf /var/lib/apt/lists/* \
    && npm i -g playwright@1.49.0

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
