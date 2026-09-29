FROM node:22-alpine AS build
WORKDIR /build
COPY package.json tsconfig.json ./
RUN npm install --no-audit --no-fund
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:22-alpine
WORKDIR /app
RUN apk add --no-cache tini
COPY --from=build /build/node_modules ./node_modules
COPY --from=build /build/dist ./dist
COPY package.json ./
ENV PORT=7012
EXPOSE 7012
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "dist/server.js"]
