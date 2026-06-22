import http from 'node:http';
import { fileURLToPath, URL } from 'node:url';

export const DEFAULT_CATCHUP_SECONDS = 5 * 60;

function isoDate(seconds) {
  return new Date(seconds * 1000).toISOString();
}

function parseProgramDateTime(line) {
  const value = line.slice('#EXT-X-PROGRAM-DATE-TIME:'.length);
  const timestamp = Date.parse(value);
  return Number.isNaN(timestamp) ? null : timestamp / 1000;
}

function isUri(line) {
  return line !== '' && !line.startsWith('#');
}

/**
 * Add a program-date-time tag immediately before every media segment when the
 * requested media playlist covers more than `catchupSeconds`. Program date-time
 * is the HLS timing metadata TiviMate uses to position a segment in catch-up.
 */
export function addCatchupTags(playlist, { catchupSeconds = DEFAULT_CATCHUP_SECONDS, now = Date.now() / 1000 } = {}) {
  const lines = playlist.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
  const segments = [];
  let pendingDuration = null;
  let pendingDurationIndex = null;
  let pendingProgramTime = null;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.startsWith('#EXT-X-PROGRAM-DATE-TIME:')) {
      pendingProgramTime = parseProgramDateTime(line);
    } else if (line.startsWith('#EXTINF:')) {
      const duration = Number.parseFloat(line.slice('#EXTINF:'.length));
      pendingDuration = Number.isFinite(duration) && duration >= 0 ? duration : 0;
      pendingDurationIndex = index;
    } else if (isUri(line) && pendingDuration !== null) {
      segments.push({ index, tagIndex: pendingDurationIndex, duration: pendingDuration, programTime: pendingProgramTime });
      pendingDuration = null;
      pendingDurationIndex = null;
      pendingProgramTime = null;
    }
  }

  const duration = segments.reduce((total, segment) => total + segment.duration, 0);
  if (segments.length === 0 || duration <= catchupSeconds) return playlist;

  // Keep an upstream clock when available. Otherwise make the last advertised
  // segment current, which gives every chunk a contiguous archive timestamp.
  const firstKnown = segments.findIndex((segment) => segment.programTime !== null);
  const start = firstKnown === -1
    ? now - duration
    : segments[firstKnown].programTime - segments.slice(0, firstKnown).reduce((total, segment) => total + segment.duration, 0);

  let cursor = start;
  const timestampsByTagLine = new Map();
  for (const segment of segments) {
    timestampsByTagLine.set(segment.tagIndex, cursor);
    cursor += segment.duration;
  }

  // Replacing, rather than duplicating, date-time tags avoids contradictory
  // clocks while guaranteeing exactly one tag for every returned chunk.
  const result = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (lines[index].startsWith('#EXT-X-PROGRAM-DATE-TIME:')) continue;
    if (timestampsByTagLine.has(index)) result.push(`#EXT-X-PROGRAM-DATE-TIME:${isoDate(timestampsByTagLine.get(index))}`);
    result.push(lines[index]);
  }
  return result.join('\n');
}

export function proxiedUrl(proxyOrigin, target, catchup = null) {
  const path = catchup ? 'catchup' : 'proxy';
  const timing = catchup ? `&start=${encodeURIComponent(catchup.start)}&duration=${encodeURIComponent(catchup.duration)}` : '';
  return `${proxyOrigin}/${path}?url=${encodeURIComponent(target)}${timing}`;
}

export function rewriteUris(playlist, sourceUrl, proxyOrigin, catchup = null) {
  const proxy = (uri) => {
    const absolute = new URL(uri, sourceUrl).toString();
    // A catch-up range applies to nested HLS manifests only. Media chunks,
    // including separate AAC audio, must be fetched as bytes without replaying
    // the range-selection handler.
    const nestedCatchup = catchup && new URL(absolute).pathname.toLowerCase().endsWith('.m3u8') ? catchup : null;
    return proxiedUrl(proxyOrigin, absolute, nestedCatchup);
  };
  return playlist
    .replace(/URI="([^"]+)"/g, (_match, uri) => `URI="${proxy(uri)}"`)
    .replace(/^([^#\r\n][^\r\n]*)$/gm, (_match, uri) => proxy(uri));
}

export function addCatchupChannelTags(playlist, sourceUrl, proxyOrigin) {
  const lines = playlist.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
  for (let index = 0; index < lines.length; index += 1) {
    if (!lines[index].startsWith('#EXTINF:') || /\bcatchup=/.test(lines[index])) continue;
    const uriIndex = lines.findIndex((line, candidate) => candidate > index && isUri(line));
    if (uriIndex === -1) continue;
    const stream = new URL(lines[uriIndex], sourceUrl).toString();
    const source = `${proxyOrigin}/catchup?url=${encodeURIComponent(stream)}&start={utc}&duration={duration}`;
    const separator = lines[index].indexOf(',');
    if (separator !== -1) {
      lines[index] = `${lines[index].slice(0, separator)} catchup="default" catchup-days="1" catchup-source="${source}"${lines[index].slice(separator)}`;
    }
  }
  return lines.join('\n');
}

export function selectCatchupRange(playlist, start, duration) {
  const lines = playlist.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
  const segments = [];
  let pendingDuration = null;
  let pendingDurationIndex = null;
  let pendingProgramTime = null;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.startsWith('#EXT-X-PROGRAM-DATE-TIME:')) pendingProgramTime = parseProgramDateTime(line);
    else if (line.startsWith('#EXTINF:')) {
      pendingDuration = Number.parseFloat(line.slice('#EXTINF:'.length));
      pendingDurationIndex = index;
    } else if (isUri(line) && pendingDuration !== null) {
      segments.push({ duration: pendingDuration, extinfIndex: pendingDurationIndex, uri: line, programTime: pendingProgramTime });
      pendingDuration = null;
      pendingDurationIndex = null;
      pendingProgramTime = null;
    }
  }
  if (segments.length === 0) return playlist;
  const selected = segments.filter((segment) => segment.programTime !== null && segment.programTime + segment.duration > start && segment.programTime < start + duration);
  if (selected.length === 0) return null;
  const headerEnd = lines.findIndex((line) => line.startsWith('#EXT-X-PROGRAM-DATE-TIME:') || line.startsWith('#EXTINF:'));
  const header = lines.slice(0, headerEnd === -1 ? lines.length : headerEnd).filter((line) => !line.startsWith('#EXT-X-ENDLIST'));
  for (const segment of selected) {
    header.push(`#EXT-X-PROGRAM-DATE-TIME:${isoDate(segment.programTime)}`, lines[segment.extinfIndex], segment.uri);
  }
  header.push('#EXT-X-ENDLIST');
  return header.join('\n');
}

function allowedTarget(target, allowlist) {
  if (!['http:', 'https:'].includes(target.protocol)) return false;
  return allowlist.length === 0 || allowlist.includes(target.hostname);
}

function isM3u8(target, contentType) {
  return target.pathname.toLowerCase().endsWith('.m3u8') || contentType.toLowerCase().includes('mpegurl');
}

export function createServer({
  fetchImpl = fetch,
  catchupSeconds = DEFAULT_CATCHUP_SECONDS,
  allowlist = (process.env.UPSTREAM_ALLOWLIST ?? '').split(',').map((value) => value.trim()).filter(Boolean),
  playlistUrl = process.env.PLAYLIST_URL,
  publicOrigin = process.env.PUBLIC_ORIGIN,
} = {}) {
  let configuredOrigin = null;
  if (publicOrigin) {
    const parsedOrigin = new URL(publicOrigin);
    if (!['http:', 'https:'].includes(parsedOrigin.protocol)) throw new Error('PUBLIC_ORIGIN must use http or https');
    configuredOrigin = parsedOrigin.origin;
  }
  return http.createServer(async (request, response) => {
    const requestOrigin = `http://${request.headers.host ?? 'localhost'}`;
    const proxyOrigin = configuredOrigin ?? requestOrigin;
    const requestUrl = new URL(request.url ?? '/', requestOrigin);
    if (requestUrl.pathname === '/health') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ ok: true }));
      return;
    }
    const isCatchupRequest = requestUrl.pathname === '/catchup';
    const isFixedPlaylistRequest = requestUrl.pathname === '/playlist.m3u';
    if (requestUrl.pathname !== '/proxy' && !isCatchupRequest && !isFixedPlaylistRequest) {
      response.writeHead(404).end('Use GET /playlist.m3u or /proxy?url=https%3A%2F%2Fupstream%2Fplaylist.m3u8');
      return;
    }

    let target;
    try {
      target = new URL(isFixedPlaylistRequest ? playlistUrl ?? '' : requestUrl.searchParams.get('url') ?? '');
    } catch {
      response.writeHead(isFixedPlaylistRequest ? 503 : 400).end(isFixedPlaylistRequest ? 'PLAYLIST_URL is not configured' : 'A valid url query parameter is required');
      return;
    }
    if (!allowedTarget(target, allowlist)) {
      response.writeHead(403).end('Upstream URL is not allowed');
      return;
    }
    const start = Number(requestUrl.searchParams.get('start'));
    const duration = Number(requestUrl.searchParams.get('duration'));
    if (isCatchupRequest && (!Number.isFinite(start) || !Number.isFinite(duration) || duration <= 0)) {
      response.writeHead(400).end('Catch-up requests require numeric start and duration query parameters');
      return;
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 20_000);
    try {
      const upstream = await fetchImpl(target, { signal: controller.signal, redirect: 'follow' });
      const contentType = upstream.headers.get('content-type') ?? 'application/octet-stream';
      if (!upstream.ok) {
        response.writeHead(upstream.status).end(`Upstream returned ${upstream.status}`);
        return;
      }
      if (isM3u8(target, contentType)) {
        const body = await upstream.text();
        const ranged = isCatchupRequest ? selectCatchupRange(body, start, duration) : body;
        if (isCatchupRequest && ranged === null) {
          response.writeHead(404).end('Requested catch-up window is not available');
          return;
        }
        const tagged = addCatchupTags(ranged, { catchupSeconds });
        // fetch follows redirects. Relative HLS URIs must be based on the final
        // response location, otherwise a redirected master playlist points its
        // video/audio renditions back at the pre-redirect host.
        const finalUrl = upstream.url || target.toString();
        const catchup = isCatchupRequest ? { start: String(start), duration: String(duration) } : null;
        const channelTagged = !body.includes('#EXT-X-') && !isCatchupRequest ? addCatchupChannelTags(tagged, finalUrl, proxyOrigin) : tagged;
        const rewritten = rewriteUris(channelTagged, finalUrl, proxyOrigin, catchup);
        response.writeHead(200, { 'content-type': 'application/vnd.apple.mpegurl; charset=utf-8', 'cache-control': 'no-store' });
        response.end(rewritten);
      } else {
        response.writeHead(200, { 'content-type': contentType, 'cache-control': 'no-store' });
        response.end(Buffer.from(await upstream.arrayBuffer()));
      }
    } catch (error) {
      response.writeHead(502).end(`Upstream request failed: ${error.message}`);
    } finally {
      clearTimeout(timeout);
    }
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT ?? 8787);
  const host = process.env.HOST || undefined;
  const server = createServer();
  server.once('error', (error) => {
    if (error.code === 'EADDRINUSE') {
      console.error(`Port ${port} is already in use. Stop the existing proxy or run: PORT=8788 npm start`);
    } else {
      console.error(`Unable to start proxy: ${error.message}`);
    }
    process.exitCode = 1;
  });
  server.listen(port, host, () => console.log(`Catch-up M3U proxy listening on ${host ?? 'all interfaces'}:${port}`));
}
