#!/bin/sh
set -e

# Seed web frontend if not present in persistent volume
if [ ! -d /app/data/web ]; then
  echo "Seeding /app/data/web..."
  mkdir -p /app/data
  cp -r /app/seed-data/web /app/data/web
fi

# Seed embedding models if not present in persistent volume
if [ ! -d /app/data/models ]; then
  echo "Seeding /app/data/models..."
  mkdir -p /app/data
  cp -r /app/seed-data/models /app/data/models
fi

exec node /app/data/serve/app.js
