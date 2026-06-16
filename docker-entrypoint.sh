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

# Seed skills subdirs if missing (app.ts auto-creates the parent dir as empty on startup)
if [ ! -d /app/data/skills/art_skills ] || [ ! -d /app/data/skills/story_skills ]; then
  echo "Seeding /app/data/skills/..."
  mkdir -p /app/data/skills
  cp -rn /app/seed-data/skills/. /app/data/skills/
fi

# Seed video model prompt templates if missing
if [ ! -d /app/data/modelPrompt/video ]; then
  echo "Seeding /app/data/modelPrompt/..."
  mkdir -p /app/data/modelPrompt
  cp -rn /app/seed-data/modelPrompt/. /app/data/modelPrompt/
fi

# Seed default assets if missing (app.ts auto-creates the parent dir as empty on startup)
if [ ! -f /app/data/assets/ending.mp4 ]; then
  echo "Seeding /app/data/assets/..."
  mkdir -p /app/data/assets
  cp -rn /app/seed-data/assets/. /app/data/assets/
fi

exec node /app/data/serve/app.js
