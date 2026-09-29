# Orion agent VM: a full Linux box per user with node, python, and a real
# headless Chromium (via Playwright) for the browser tools.
FROM mcr.microsoft.com/playwright:v1.49.0-noble

# Lean on top of the Playwright base (node + chromium + playwright already
# there): just the scripting basics, plus the Docker CLI so the agent can
# use the host's Docker daemon (socket is mounted at run time; the daemon
# itself runs on the host, not in here).
#
# Python: pip is available; the agent installs what it needs with
# pip install (running as root). Keep the base image lean — don't pre-install
# heavy stacks like torch/numpy here.
RUN apt-get update && apt-get install -y --no-install-recommends \
        python3 python3-pip python3-venv git curl jq docker.io \
    && rm -rf /var/lib/apt/lists/* \
    && npm i -g playwright@1.49.0 \
    && docker --version

ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    NODE_PATH=/usr/local/lib/node_modules:/usr/lib/node_modules

# The agent gets FULL root inside its sandbox VM. This is safe because the
# container itself is heavily isolated: all capabilities dropped,
# no-new-privileges, no privileged mode, filtered Docker proxy (not the raw
# socket), resource limits, no host networking. Root here cannot escape to
# the host or other users' sandboxes.
#
# The workspace stays at /home/agent/workspace for path compatibility.
RUN usermod -l agent pwuser && groupmod -n agent pwuser \
    && usermod -d /home/agent -m agent \
    && mkdir -p /home/agent/workspace/.shots \
    && chown -R agent:agent /home/agent

COPY orion-browser.js /usr/local/bin/orion-browser
RUN chmod +x /usr/local/bin/orion-browser

WORKDIR /home/agent/workspace

CMD ["sleep", "infinity"]
