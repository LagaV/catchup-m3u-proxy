FROM node:24-alpine

WORKDIR /app

COPY package.json ./
COPY src ./src

# Fail the image build instead of starting a restart loop if the deployment
# context omitted the application source directory.
RUN test -f /app/src/server.js

ENV NODE_ENV=production
ENV PORT=8787

EXPOSE 8787

CMD ["npm", "start"]
