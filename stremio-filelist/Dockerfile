ARG BUILD_FROM
FROM ${BUILD_FROM}

RUN apk add --no-cache nodejs npm python3 make g++

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && apk del python3 make g++

COPY index.js helpers.js ./

COPY rootfs /
RUN chmod a+x /etc/s6-overlay/s6-rc.d/stremio-filelist/run \
    /etc/s6-overlay/s6-rc.d/stremio-filelist/finish
