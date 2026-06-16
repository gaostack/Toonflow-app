# ================= 构建阶段 =================
FROM node:24-bookworm-slim AS builder

WORKDIR /app

# 国内源加速（海外服务器可删除）
RUN npm config set registry https://registry.npmmirror.com/ && \
    yarn config set registry https://registry.npmmirror.com/

COPY . .

# 去掉 Electron 相关依赖，避免在 Linux 容器里下载桌面二进制
RUN node -e "\
const fs=require('fs');\
const pkg=JSON.parse(fs.readFileSync('package.json','utf8'));\
for(const section of ['dependencies','devDependencies']){\
  if(!pkg[section]) continue;\
  for(const name of ['custom-electron-titlebar','electron','electron-builder','electron-rebuild','electronmon']){\
    delete pkg[section][name];\
  }\
}\
fs.writeFileSync('package.json', JSON.stringify(pkg, null, 2)+'\\n');\
"

RUN yarn install --frozen-lockfile && \
    yarn cache clean && \
    yarn build

# ================= 运行阶段 =================
FROM node:24-bookworm-slim AS runner

WORKDIR /app

ENV NODE_ENV=prod
ENV PORT=10588

# 只复制生产运行所需文件
COPY --from=builder /app/data/serve ./data/serve
COPY --from=builder /app/data/web ./seed-data/web
COPY --from=builder /app/data/models ./seed-data/models
COPY --from=builder /app/data/skills ./seed-data/skills
COPY --from=builder /app/package.json ./
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/docker-entrypoint.sh ./docker-entrypoint.sh

RUN chmod +x /app/docker-entrypoint.sh

# data 目录通过 Coolify 持久化卷挂载
EXPOSE 10588

CMD ["/app/docker-entrypoint.sh"]
