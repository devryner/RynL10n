# RynL10n 관리 백엔드 (단일 노드) — 기획서 9.1
# 네이티브 TS 타입 스트리핑(Node >=23.6) + node:sqlite 내장 → 빌드 스텝·외부 런타임 의존성 없음.
FROM node:24-alpine

WORKDIR /app
# backend는 ../src(M0 참조 빌더)를 재사용하므로 두 트리를 모두 포함한다.
COPY package.json ./
COPY src ./src
COPY backend ./backend

ENV RYNL10N_PORT=8787 \
    RYNL10N_DELIVERY_PORT=8788 \
    RYNL10N_DB=/data/rynl10n.db \
    RYNL10N_STORAGE=/data/storage

EXPOSE 8787 8788
VOLUME ["/data"]

# node:sqlite가 플래그를 요구하는 버전이면 --experimental-sqlite 추가.
CMD ["node", "backend/src/main.ts"]
