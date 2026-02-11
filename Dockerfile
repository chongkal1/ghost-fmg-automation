FROM mcr.microsoft.com/playwright:v1.58.0-noble

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci --production

COPY . .

RUN mkdir -p screenshots

EXPOSE 3000

CMD ["node", "src/index.js"]
