ARG BUILD_FROM
FROM ${BUILD_FROM}

RUN apk add --no-cache nodejs npm

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --production

COPY index.js helpers.js run.sh ./

RUN chmod a+x run.sh

CMD ["./run.sh"]
