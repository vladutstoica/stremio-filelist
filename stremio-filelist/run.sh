#!/usr/bin/with-contenv bashio

# Read configuration from HA add-on options
export FILELIST_USER=$(bashio::config 'FILELIST_USER')
export FILELIST_PASSKEY=$(bashio::config 'FILELIST_PASSKEY')
export HOST=0.0.0.0
export PORT=7777
export TORRENT_DIR=/share/stremio-filelist

mkdir -p "$TORRENT_DIR"

bashio::log.info "Starting Stremio FileList addon..."
exec node index.js
