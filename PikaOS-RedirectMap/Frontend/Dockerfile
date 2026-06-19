# Website Compare frontend — Vite dev server in Docker.
# Source + node_modules come in as volumes at runtime (see ../docker-compose.yml): the bind
# mount gives hot reload, a named volume keeps node_modules off the host. Deps are installed
# at build time so `up` is fast; the named volume is seeded from this layer.
FROM node:22-alpine
WORKDIR /app
COPY package*.json ./
RUN npm install
EXPOSE 5173
CMD ["npm", "run", "dev"]
