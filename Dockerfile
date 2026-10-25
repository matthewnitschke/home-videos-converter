FROM node:24-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg fonts-dejavu-core ca-certificates tzdata \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

RUN npm install -g pnpm@12.15.0

COPY package.json pnpm-lock.yaml ./
RUN pnpm install --prod --frozen-lockfile

COPY server ./server
COPY frontend ./frontend

ENV NODE_ENV=production
ENV PORT=3000
# Mount the folder you want to list here: -v /path/to/videos:/media
ENV MEDIA_DIR=/media

RUN mkdir -p /media && chown node:node /media

EXPOSE 3000
VOLUME ["/media"]

USER node

CMD ["node", "server/server.ts"]
