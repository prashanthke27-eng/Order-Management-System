FROM node:20-slim

WORKDIR /srv/app

# Install dependencies first (better layer caching)
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# Application files
COPY server.js index.html seed-data.json ./
COPY "Final Web App .xlsx" ./

ENV NODE_ENV=production
ENV DB_PATH=/data/erp.db
EXPOSE 3000

CMD ["node", "server.js"]
