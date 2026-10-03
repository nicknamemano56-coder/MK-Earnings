FROM node:22-bookworm
WORKDIR /app
COPY server.js package.json .env.example ./
ENV PORT=8787
EXPOSE 8787
CMD ["node","server.js"]
