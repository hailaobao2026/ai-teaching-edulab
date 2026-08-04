FROM node:20-slim

WORKDIR /app

# Python + sympy for edulab skills
RUN apt-get update && apt-get install -y --no-install-recommends python3 python3-pip && rm -rf /var/lib/apt/lists/*
RUN pip3 install --break-system-packages sympy --no-cache-dir

COPY package.json package-lock.json ./
RUN npm ci

COPY server/package.json server/package-lock.json* ./server/
RUN cd server && npm ci --omit=dev

COPY . .

RUN npm run build
RUN npm prune --omit=dev

EXPOSE 3002
CMD ["node", "server/index.js"]
