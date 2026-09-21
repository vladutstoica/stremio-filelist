# Changelog

## 1.12.6

Fixes playback pausing for a few seconds at a time on large 4K releases.

Pieces of a film arrive in order, and if the one needed next is coming from a
slow peer, everything stops until it lands -- the other peers have already sent
what they were asked for and sit idle. In the log this looks like the download
speed swinging between full speed and nothing.

The underlying library can rescue a piece from a slow peer and ask a faster one
instead, but it only did so for the piece playback was already waiting on, and
only after it had stopped. Worse, on big films it worked out to no piece at all:
the rule it used assumed pieces smaller than a megabyte, and a 27 GB film has
pieces many times that size. The add-on now marks the next few seconds of film
ahead of where you are watching, so a slow peer is replaced before playback
reaches it rather than after it has already stalled.

If pauses persist on a very large release, it is worth raising MAX_CONNS -- more
peers means more alternatives to swap to -- and DOWNLOAD_LIMIT_MBPS, which at
its default of 8 MB/s is close to what a 4K IMAX release needs just to keep up.

## 1.12.5

Makes the add-on log say where playback has actually got to.

The log line used to report "Progress", which was the share of the film sitting
in memory -- so on a 16 GB film with a 500 MB cache it read 3% and stayed there,
whether you were five minutes in or almost at the end, and whether the stream
was healthy or had stopped dead. It now reports how far through the file the
player has read, and how much the cache is holding:

    Peers: 17 | Down: 7.8 MB/s | At: 11.6 GB (70.8%) | Cache: 486 MB in 62 pieces

If "At" stops moving while the download carries on, something is wrong. That is
the thing the old line could never show.

Nothing about streaming itself changed in this release.

## 1.12.4

Fixes playback stopping with an error after a few minutes.

The player does not open one connection to a film, it opens several: the one
following what you are watching, plus short ones that re-read the beginning
and the end of the file, plus the occasional re-open of the whole thing. All of
them were sharing a single memory window, and whichever connection asked last
decided which part of the film was worth keeping. So the pieces just ahead of
what you were watching were thrown away moments before they were needed,
fetched again, and thrown away again. Playback ran out of material and stopped,
while the download itself carried on at full speed.

Each connection now keeps its own window, and a window is never shrunk by a
connection that turns up later. A piece that is already being read can no
longer be discarded out from under the reader.

The trade-off is that each connection gets a smaller share of the memory than
the single shared window used to hand out, so there is less read-ahead. At
normal bitrates there is still well over half a minute of buffer; on very high
bitrate releases, such as 4K remuxes, raise `CACHE_SIZE_MB`.

Also, a stream that genuinely cannot continue -- the piece it is waiting for
never arrives -- now drops the connection after a few seconds instead of ending
as though the film had finished. Ending quietly is what the player and the
proxy in front of it were turning into that error; a dropped connection is
something the player simply reconnects to.

## 1.12.3

Fixes playback stopping after a few minutes.

Two faults, both in the streaming window added in 1.11.0:

- The window being fetched was as large as the whole memory budget, so the
  moment it filled, the cache had to throw away pieces that were still needed.
  They were fetched again, thrown away again, and playback starved while the
  download sat at its speed limit. The window is now sized well inside the
  budget.
- When the cache did have to drop something still in use, it dropped the piece
  nearest the playhead -- the one needed next. It now drops the furthest away.

Also, the add-on now tells peers when it discards a piece. Without that they
still believe it holds the whole file, treat it as a seed, and stop sending
data, making it impossible to fetch anything again.

## 1.12.2

Fixes "No streams were found" in Stremio.

1.12.0 sent both `title` and `description` on every stream. Stremio treats
`title` as an alias of `description`, and rejects a response that carries both
-- so the whole stream list failed to load even though the add-on was serving
it correctly. Only one is sent now.

If you were affected, no reconfiguration is needed; update and the list comes
back.

## 1.12.1

Fixes the quality badge disagreeing with the release details.

The badge was matched against the whole release name, so a 1080p encode of a
UHD source was labelled `4K`, and any BluRay was labelled `1080p` even when it
was 720p. It now uses the same resolution shown in the details line and used
for ranking.

## 1.12.0

Readable stream names.

Stremio previously showed the raw release name, e.g.
`Moana.2026.1080p.AMZN.WEB-DL.DDP5.1.H.264-KyoGo`. Releases now appear as a
title, a specs line, and a stats line:

```
Moana (2026)
1080p · WEB-DL · H.264 · DDP5.1
19.5 GB · 👤 24 · AMZN · KyoGo
```

Series show the episode, any episode range, and the episode title where the
release carries one, e.g. `Las Fierbinti S30E02 - Fantoma Partea 2`. Season
packs keep their season number and sub-title (`Insula Iubirii S09 - Casa
Baietilor`); previously every season of a show rendered identically.

Freeleech, double-upload and internal releases are flagged next to the title
(`🆓`, `2×UP`, `INTERNAL`), so you can see at a glance which ones do not count
against your ratio.

Results are also ordered more usefully. Releases with too few seeders are
pushed to the bottom -- with the streaming window capped, a release whose swarm
cannot keep up stutters where a smaller one plays fine -- then by quality, then
freeleech, then seeders.

Parsing uses `parse-torrent-title` against standard scene naming. Release names
are convention rather than a standard, so anything unrecognisable falls back to
the raw name instead of showing something wrong.

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
