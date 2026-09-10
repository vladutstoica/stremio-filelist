# Changelog

## 1.11.0

Streaming no longer downloads the whole film.

Previously the add-on fetched an entire release as fast as the swarm allowed and
wrote all of it to disk. On a Home Assistant Green that meant 25-39 MB/s onto
the eMMC, which the card cannot absorb: writes piled up in RAM until the kernel
forced a flush that blocked everything else, including Home Assistant itself.
A 4K film also simply did not fit in the free space.

It now keeps a moving window of roughly 500 MB around the point you are
watching, in RAM, and drops what you have already passed.

**What you will notice**

- Home Assistant no longer becomes unresponsive during playback.
- Films larger than your free disk space now play, including 4K remuxes.
- Nothing is written to the eMMC at all, so it no longer wears out.
- Several people can watch different films at once; the memory budget is shared.
- Skipping backwards further than the retained window pauses for a few seconds
  while those pieces are fetched again.
- **`progress` in the status API no longer climbs to 100%.** It reports what is
  currently held, and pieces are dropped once watched, so it hovers low and
  fluctuates. This is the window working, not a stalled download.

**New options**

| Option | Default | Description |
|---|---|---|
| `CACHE_SIZE_MB` | `500` | Total RAM held across all active streams |
| `READ_AHEAD_PCT` | `95` | Share of the window kept ahead of the playhead |
| `DOWNLOAD_LIMIT_MBPS` | `8` | Fetch rate cap, in MB/s |
| `MAX_CONNS` | `20` | Max peer connections |

If playback stutters on a very high bitrate release, raise `CACHE_SIZE_MB`.
Leftover downloads from earlier versions are wiped from `/share/stremio-filelist/`
on first start.

---

Earlier releases are documented in the
[GitHub releases](https://github.com/vladutstoica/stremio-filelist/releases).
