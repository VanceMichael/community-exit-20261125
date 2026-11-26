FROM node:22.23.4-bookworm-slim
WORKDIR /app
COPY --chown=node:node . .
RUN mkdir -p /app/.local && chown node:node /app/.local
USER node
# 4317 外部承运台协议服务；4318 入退驻业务 HTTP 服务
EXPOSE 4317 4318
# 默认仍启动承运台；业务服务使用 npm run start:app，可通过容器编排同时启动。
CMD ["npm", "run", "start:partner"]
