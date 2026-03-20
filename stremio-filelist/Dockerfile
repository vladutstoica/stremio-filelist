ARG BUILD_FROM
FROM ${BUILD_FROM}

RUN apk add --no-cache nodejs npm python3 make g++

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && apk del python3 make g++

COPY index.js helpers.js ./

COPY run.sh /etc/services.d/stremio-filelist/run
RUN chmod a+x /etc/services.d/stremio-filelist/run
