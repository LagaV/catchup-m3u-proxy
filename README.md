# Catch-up M3U proxy

An HLS (`.m3u8`) reverse proxy with a short, stateless catch-up window. It adds
`#EXT-X-PROGRAM-DATE-TIME` before every media chunk only when the returned media
playlist spans **more than five minutes**. Existing program-date-time tags are
normalized to one contiguous tag per chunk, so no contradictory timestamps are
returned.

For top-level channel M3U playlists, the proxy adds the `catchup="default"`,
`catchup-days`, and `catchup-source` attributes that TiviMate and Kodi IPTV Simple
use to expose catch-up from the guide. `catchup-source` targets a URL-safe local
`/catchup/<channel>/{utc}/{duration}.m3u8` route, which selects the requested time range from the source HLS
playlist. The effective archive is limited to the source playlist's current
sliding window (two hours for the tested ARD feed), not a full-day archive.

## Run

Requires Node 18+ (Node 20+ recommended).

```sh
npm test
npm start
```

Request a playlist through the proxy:

```text
http://localhost:8787/proxy?url=https%3A%2F%2Forigin.example%2Flive%2Fchannel.m3u8
```

## Docker Compose

Set the allowed upstream hosts in `compose.yml`, including hosts reached after
redirects, then deploy:

```sh
docker compose up -d --build
```

Run Compose from the project directory. Its build context must include all of
these paths: `compose.yml`, `Dockerfile`, `package.json`, and `src/server.js`.
The image build deliberately fails if `src/server.js` is missing, rather than
creating a container that restarts continuously.

To expose a fixed client playlist, create a `.env` file beside `compose.yml`:

```dotenv
PLAYLIST_URL=https://provider.example/playlist.m3u?username=YOUR_USER&password=YOUR_PASSWORD
PUBLIC_ORIGIN=https://...:8787
PROXY_LOG=true
ZDF_CATCHUP_PROBE_DAYS=3
KODI_FFMPEGDIRECT=true
```

Then configure TiviMate or Kodi with `http://192.168.1.50:8787/playlist.m3u`.
`PUBLIC_ORIGIN` is required when the client reaches the container through a
different address than the request host, such as a reverse proxy or Docker host.
Set `PROXY_LOG=true` to log each proxy request, its HTTP result, and elapsed
time. Query strings are deliberately omitted so provider credentials in playlist
URLs are not written to Docker logs.

At each proxy start, ZDF starts with `catchup-days="1"` and is then measured in
the background. `ZDF_CATCHUP_PROBE_DAYS` defines how far back that discovery
searches; the resulting number of started days is used in subsequently served
channel playlists. The server still probes the actual segment boundary: a
programme that only partly overlaps the retained archive is returned only from
its first available segment; an entirely expired programme is reported
unavailable.

Set `KODI_FFMPEGDIRECT=true` only for Kodi-focused deployments. It inserts
`#KODIPROP:inputstream=inputstream.ffmpegdirect` before each channel entry, so
Kodi IPTV Simple can select the ffmpegdirect inputstream for live timeshift and
catch-up. The `inputstream.ffmpegdirect` Kodi add-on must be installed and
enabled on the client.

The proxy will be available on port `8787` of the Docker host. Use the Docker
host's LAN or Tailscale address (not `localhost`) in TiviMate or Kodi when the
player runs on another device. The Compose file leaves `UPSTREAM_ALLOWLIST`
empty because playlists can redirect to multiple CDN hosts. Restrict the service
to a trusted network, or set that variable to the complete comma-separated host
allowlist before deployment.

The supplied Compose file uses Linux host networking so it does not allocate a
Docker bridge subnet. It binds the proxy only to `127.0.0.1:8787`, for use with
Tailscale Serve or a local reverse proxy. This is appropriate for a Linux server,
NAS, or VM. For Docker Desktop, use a normal bridged Compose network and resolve
Docker's address-pool exhaustion in the Docker daemon configuration instead.

All relative chunk, variant-playlist, key, and map URLs are rewritten through the
same `/proxy` endpoint and resolved against the final URL after any upstream
redirect. Non-playlist responses are streamed back unchanged.

## Configuration

`PORT` defaults to `8787`.

Set `UPSTREAM_ALLOWLIST` to a comma-separated host allowlist in any exposed
deployment, for example `UPSTREAM_ALLOWLIST=iptv.example.net,cdn.example.net`.
Without it, any HTTP(S) upstream is accepted, which is appropriate only for a
trusted local deployment.

The threshold is deliberately strict: a playlist totaling exactly 300 seconds is
left untouched; 300.001 seconds receives one program-date-time tag for every
segment. The proxy does not fabricate provider-specific `catchup-source` M3U
attributes—those belong to a top-level channel playlist, not individual HLS chunks.
