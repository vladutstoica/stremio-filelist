# stremio-filelist

A Stremio addon that streams torrents from [FileList.io](https://filelist.io). Runs locally or as a Home Assistant add-on, connects to FileList's private tracker, and serves video over HTTP to Stremio.

## Features

- Search FileList by IMDB ID (movies and series)
- Handles both **individual episodes** and **season packs** (auto-selects the correct episode file)
- Streams via a local torrent engine with proper private tracker support
- Quality tags (4K, 1080p, 720p, HD, SD) and seeder count in stream listing
- Accessible over local network (use from phone, TV, other devices on WiFi)
- Auto-pauses download when you stop watching
- Auto-cleanup of downloaded files after 5 minutes of inactivity
- Cleans up leftover downloads on startup
- Status API for monitoring active torrents

## Option 1: Run standalone

### Requirements

- Node.js >= 22
- A [FileList.io](https://filelist.io) account with API access (passkey)

### Setup

```bash
npm install

cp .env.example .env
# Edit .env with your FileList username and passkey
```

Your FileList passkey can be found in your profile under **Settings**.

### Usage

```bash
npm start
```

The addon will print two URLs:

```
Install in Stremio (this PC):   http://127.0.0.1:7777/manifest.json
Install in Stremio (network):   http://192.168.x.x:7777/manifest.json
```

- **This PC** — use when Stremio runs on the same machine
- **Network** — use from any device on your local WiFi (phone, smart TV, etc.)

Open the URL in a browser or paste it into Stremio (**Add-ons > Add addon via URL**).

### Configuration

All configuration is via `.env` (or environment variables):

| Variable | Required | Default | Description |
|---|---|---|---|
| `FILELIST_USER` | Yes | — | Your FileList username |
| `FILELIST_PASSKEY` | Yes | — | Your FileList passkey |
| `PORT` | No | `7777` | Server port |
| `HOST` | No | `0.0.0.0` | Bind address |
| `LOCAL_IP` | No | auto-detected | IP used in stream URLs |
| `TORRENT_DIR` | No | OS temp dir | Where torrents download to |

## Option 2: Home Assistant Add-on

Run as a managed add-on on Home Assistant for always-on availability. Works great on [Home Assistant Green](https://www.home-assistant.io/green/) or any HA OS installation.

### Install

1. In Home Assistant, go to **Settings > Add-ons > Add-on Store**
2. Click the three-dot menu (top right) > **Repositories**
3. Add: `https://github.com/vladutstoica/stremio-filelist`
4. Refresh the page, find **Stremio FileList** and click **Install**
5. Go to the **Configuration** tab and enter your FileList username and passkey
6. Enable **Start on boot** and **Autoupdate**
7. Click **Start**

### Connect Stremio

The addon runs on port 7777 using your HA device's network. Find your HA IP in **Settings > System > Network**, then add in Stremio:

```
http://<your-ha-ip>:7777/manifest.json
```

This works from any device on your local WiFi (phone, smart TV, laptop, etc.).

### Storage

The add-on uses host networking and stores downloads in `/share/stremio-filelist/`. Storage is managed automatically:

- Downloads are cleaned up 5 minutes after you stop watching
- All leftover downloads are wiped on add-on startup
- Files are deselected immediately when you stop watching to pause the download

### Dashboard (optional)

To see torrent status on your HA dashboard, add a REST sensor to your `configuration.yaml`:

```yaml
sensor:
  - platform: rest
    name: Stremio FileList
    resource: http://localhost:7777/status
    value_template: "{{ value_json.torrents | length }}"
    unit_of_measurement: "torrents"
    json_attributes:
      - torrents
    scan_interval: 10
```

Then add a Markdown card to your dashboard:

```yaml
type: markdown
title: Stremio FileList
content: >
  {% if state_attr('sensor.stremio_filelist', 'torrents') | length == 0 %}
  No active torrents
  {% else %}
  {% for t in state_attr('sensor.stremio_filelist', 'torrents') %}
  **{{ t.name | truncate(40) }}**
  State: {{ t.state }} | Progress: {{ t.progress }}%
  Down: {{ (t.downloadSpeed / 1024) | round(1) }} MB/s | Peers: {{ t.peers }}
  {% endfor %}
  {% endif %}
```

## How it works

1. Stremio requests streams for a movie/series by IMDB ID
2. The addon searches FileList's API for matching torrents
3. For season packs, it downloads the `.torrent` file to identify which file matches the requested episode
4. When you click play, the addon starts a local torrent engine (WebTorrent with qBittorrent-compatible peer ID for FileList's client whitelist)
5. The video is streamed over HTTP to Stremio with range request support (seeking works)
6. When you stop watching, the torrent pauses; after 5 minutes idle, files are cleaned up

## Status API

The addon exposes a `/status` endpoint returning JSON with active torrent states:

```bash
curl http://localhost:7777/status
```

```json
{
  "torrents": [
    {
      "name": "Movie.2024.1080p.BluRay",
      "state": "downloading",
      "progress": 45.2,
      "downloadSpeed": 35840,
      "uploadSpeed": 512,
      "peers": 12,
      "activeStreams": 1
    }
  ]
}
```

States: `downloading` (active stream), `paused` (stream stopped, pending cleanup), `idle`.

## License

MIT
