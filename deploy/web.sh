#!/bin/bash
set -e
pnpm install --frozen-lockfile
pnpm build:web
rsync -avz apps/web/.output/* root@aomei:/data/web/changan