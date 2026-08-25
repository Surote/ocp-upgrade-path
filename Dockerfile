FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM gcr.io/distroless/nodejs22-debian12
WORKDIR /app
COPY --from=build /app/dist ./dist
COPY --from=build /app/server.js ./server.js
EXPOSE 8080
ENV PORT=8080
CMD ["server.js"]
