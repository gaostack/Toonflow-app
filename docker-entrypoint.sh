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

# Seed skills if not present in persistent volume
if [ ! -d /app/data/skills ]; then
  echo "Seeding /app/data/skills..."
  mkdir -p /app/data
  cp -r /app/seed-data/skills /app/data/skills
fi

# Seed video model prompt templates if not present in persistent volume
if [ ! -d /app/data/modelPrompt ]; then
  echo "Seeding /app/data/modelPrompt..."
  mkdir -p /app/data
  cp -r /app/seed-data/modelPrompt /app/data/modelPrompt
fi

# Seed default assets (e.g. ending.mp4) if not present in persistent volume
if [ ! -d /app/data/assets ]; then
  echo "Seeding /app/data/assets..."
  mkdir -p /app/data
  cp -r /app/seed-data/assets /app/data/assets
fi

exec node /app/data/serve/app.js
