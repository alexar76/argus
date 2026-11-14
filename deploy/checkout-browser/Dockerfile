FROM mcr.microsoft.com/playwright:v1.64.1-noble@sha256:2f05f8a734509a7b3f26a912639488ee08f58a7b292d14d62271bcff9038768f
WORKDIR /app

COPY playwright-core-1.64.1.tgz /tmp/playwright-core.tgz
RUN echo '042e2cf32e9211503a435ad2c594eda3c848d4a508df15e51c6660bc6a8fe08a8f748fdae855fd1f6f480cdcfbbcaa3d976d5be8b7d8a2c49c3cbe8cdf1c720d  /tmp/playwright-core.tgz' | sha512sum -c - \
    && mkdir -p node_modules/playwright-core \
    && tar -xzf /tmp/playwright-core.tgz --strip-components=1 -C node_modules/playwright-core \
    && rm /tmp/playwright-core.tgz

COPY --chmod=0444 server.mjs smoke.mjs /app/
COPY --chmod=0555 entrypoint.sh /app/entrypoint.sh
ENV NODE_ENV=production HOME=/tmp
USER 1000:1000
ENTRYPOINT ["/app/entrypoint.sh"]
