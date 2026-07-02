# Single-stage build: installs all three workspaces (including desktop-app's
# Electron/devDependencies, unused at runtime but harmless in a container
# image that isn't shipped to end users) and builds the web client, then
# runs the relay directly. Simplicity over image-size optimization here —
# this is a small personal/class project, not a production fleet.
FROM node:22-slim

WORKDIR /app

COPY package.json package-lock.json ./
COPY relay-server/package.json relay-server/package.json
COPY desktop-app/package.json desktop-app/package.json
COPY web-client/package.json web-client/package.json

RUN npm ci --include=dev

COPY . .
RUN npm run build:web

WORKDIR /app/relay-server
EXPOSE 3000
CMD ["node", "index.js"]
