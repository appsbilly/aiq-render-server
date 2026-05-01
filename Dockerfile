FROM node:20-bookworm-slim

RUN apt-get update && apt-get install -y \
    ffmpeg \
    fonts-liberation \
    fonts-dejavu \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev

COPY src ./src

ENV PORT=3001
EXPOSE 3001

CMD ["node", "src/server.js"]
