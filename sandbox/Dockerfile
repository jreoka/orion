# Orion agent VM: a full Linux box per user with node, python, and a real
# headless Chromium (via Playwright) for the browser tools.
FROM mcr.microsoft.com/playwright:v1.49.0-noble

# Lean on top of the Playwright base (node + chromium + playwright already
# there): just the scripting basics, plus the Docker CLI so the agent can
# use the host's Docker daemon (socket is mounted at run time; the daemon
# itself runs on the host, not in here).
RUN apt-get update && apt-get install -y --no-install-recommends \
        python3 python3-pip python3-venv git curl jq docker.io \
    && rm -rf /var/lib/apt/lists/* \
    && npm i -g playwright@1.49.0 \
    && docker --version

# Python data-science stack: the agent does real ML work (torch, numpy, scipy).
# CPU-only torch keeps the image lean. Installed system-wide so the non-root
# `agent` user can import them without pip install.
RUN pip3 install --no-cache-dir --break-system-packages \
        numpy scipy \
        torch --index-url https://download.pytorch.org/whl/cpu \
    && python3 -c "import numpy, torch; print('numpy', numpy.__version__, '| torch', torch.__version__)"

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
