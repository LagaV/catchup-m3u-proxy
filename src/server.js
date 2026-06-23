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

export function addCatchupChannelTags(playlist, sourceUrl, proxyOrigin, catchupDaysForChannel = () => 1) {
  const lines = playlist.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
  for (let index = 0; index < lines.length; index += 1) {
    if (!lines[index].startsWith('#EXTINF:') || /\bcatchup=/.test(lines[index])) continue;
    const uriIndex = lines.findIndex((line, candidate) => candidate > index && isUri(line));
    if (uriIndex === -1) continue;
    const stream = new URL(lines[uriIndex], sourceUrl).toString();
    // Kodi's ffmpegdirect passes this string straight into its catch-up URL
    // formatter. A path form avoids a nested URL and raw ampersands there.
    const source = `${proxyOrigin}/catchup/${Buffer.from(stream).toString('base64url')}/{utc}/{duration}.m3u8`;
    const catchupDays = Math.max(1, Math.ceil(Number(catchupDaysForChannel(lines[index], stream)) || 1));
    const separator = lines[index].indexOf(',');
    if (separator !== -1) {
      lines[index] = `${lines[index].slice(0, separator)} catchup="default" catchup-days="${catchupDays}" catchup-source="${source}"${lines[index].slice(separator)}`;
    }
  }
  return lines.join('\n');
}

export function addKodiFfmpegDirect(playlist) {
  const lines = playlist.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
  const result = [];
  for (const line of lines) {
    if (line.startsWith('#EXTINF:') && result.at(-1) !== '#KODIPROP:inputstream=inputstream.ffmpegdirect') {
      result.push('#KODIPROP:inputstream=inputstream.ffmpegdirect');
    }
    result.push(line);
  }
  return result.join('\n');
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

function parseMediaSegments(playlist) {
  const lines = playlist.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
  const mediaSequence = Number(lines.find((line) => line.startsWith('#EXT-X-MEDIA-SEQUENCE:'))?.slice('#EXT-X-MEDIA-SEQUENCE:'.length));
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
  return { lines, mediaSequence, segments };
}

function zdfSegmentTemplate(uri, sourceUrl, expectedSequence) {
  const absolute = new URL(uri, sourceUrl).toString();
  const match = absolute.match(/^(.*\/)(\d+)\.(ts|aac)$/);
  if (!match || Number(match[2]) !== expectedSequence) return null;
  return (sequence) => `${match[1]}${sequence}.${match[3]}`;
}

export function zdfCatchupPlaylist({ playlist, sourceUrl, start, duration, earliestSequence }) {
  const parsed = parseMediaSegments(playlist);
  const first = parsed.segments[0];
  if (!first || !Number.isInteger(parsed.mediaSequence) || first.programTime === null || Math.abs(first.duration - 2) > 0.001) return undefined;
  const segmentUrl = zdfSegmentTemplate(first.uri, sourceUrl, parsed.mediaSequence);
  if (!segmentUrl) return undefined;

  const requestedFirst = parsed.mediaSequence + Math.floor((start - first.programTime) / first.duration);
  const requestedLast = Math.min(
    parsed.mediaSequence + parsed.segments.length - 1,
    parsed.mediaSequence + Math.ceil((start + duration - first.programTime) / first.duration) - 1,
  );
  const firstSequence = Math.max(requestedFirst, earliestSequence);
  if (firstSequence > requestedLast) return null;

  const headerEnd = parsed.lines.findIndex((line) => line.startsWith('#EXT-X-PROGRAM-DATE-TIME:') || line.startsWith('#EXTINF:'));
  const header = parsed.lines.slice(0, headerEnd === -1 ? parsed.lines.length : headerEnd)
    .filter((line) => !line.startsWith('#EXT-X-ENDLIST'))
    .map((line) => line.startsWith('#EXT-X-MEDIA-SEQUENCE:') ? `#EXT-X-MEDIA-SEQUENCE:${firstSequence}` : line);
  for (let sequence = firstSequence; sequence <= requestedLast; sequence += 1) {
    const programTime = first.programTime + (sequence - parsed.mediaSequence) * first.duration;
    header.push(`#EXT-X-PROGRAM-DATE-TIME:${isoDate(programTime)}`, `#EXTINF:${first.duration},`, segmentUrl(sequence));
  }
  header.push('#EXT-X-ENDLIST');
  return header.join('\n');
}

async function findZdfArchiveBoundary({ playlist, sourceUrl, start, fetchImpl, cache }) {
  const parsed = parseMediaSegments(playlist);
  const first = parsed.segments[0];
  if (!first || !Number.isInteger(parsed.mediaSequence) || first.programTime === null || Math.abs(first.duration - 2) > 0.001) return undefined;
  const segmentUrl = zdfSegmentTemplate(first.uri, sourceUrl, parsed.mediaSequence);
  if (!segmentUrl) return undefined;
  const cacheKey = segmentUrl(parsed.mediaSequence).replace(/\d+\.ts$/, '{sequence}.ts');
  const cached = cache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.sequence;

  const requestedFirst = parsed.mediaSequence + Math.floor((start - first.programTime) / first.duration);
  if (requestedFirst >= parsed.mediaSequence) return parsed.mediaSequence;
  const available = async (sequence) => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 4_000);
    try {
      // Akamai closes Node HEAD requests for some ZDF AAC renditions even when
      // the segment exists. A one-byte range GET reliably validates existence
      // without downloading the complete media chunk.
      const response = await fetchImpl(segmentUrl(sequence), {
        headers: { Range: 'bytes=0-0' },
        signal: controller.signal,
        redirect: 'follow',
      });
      await response.body?.cancel();
      return response.ok;
    } catch {
      return false;
    } finally {
      clearTimeout(timeout);
    }
  };
  let low = requestedFirst;
  let high = parsed.mediaSequence; // The current playlist proves this segment exists.
  if (await available(low)) high = low;
  else {
    while (low + 1 < high) {
      const middle = Math.floor((low + high) / 2);
      if (await available(middle)) high = middle;
      else low = middle;
    }
  }
  cache.set(cacheKey, { sequence: high, expiresAt: Date.now() + 5 * 60_000 });
  return high;
}

function firstUriFollowing(lines, index) {
  for (let candidate = index + 1; candidate < lines.length; candidate += 1) {
    if (isUri(lines[candidate])) return lines[candidate];
  }
  return null;
}

async function resolveZdfMediaPlaylist({ playlistUrl, fetchImpl }) {
  let target = new URL(playlistUrl);
  for (let depth = 0; depth < 4; depth += 1) {
    const response = await fetchImpl(target, { redirect: 'follow' });
    if (!response.ok) return null;
    const body = await response.text();
    const finalUrl = response.url || target.toString();
    const parsed = parseMediaSegments(body);
    if (parsed.segments.length > 0) return { playlist: body, sourceUrl: finalUrl };
    const zdfIndex = parsed.lines.findIndex((line) => /tvg-name="ZDF"/i.test(line));
    const streamUri = zdfIndex === -1
      ? parsed.lines.find((line, index) => line.startsWith('#EXT-X-STREAM-INF:') && firstUriFollowing(parsed.lines, index)) && firstUriFollowing(parsed.lines, parsed.lines.findIndex((line) => line.startsWith('#EXT-X-STREAM-INF:')))
      : firstUriFollowing(parsed.lines, zdfIndex);
    if (!streamUri) return null;
    target = new URL(streamUri, finalUrl);
  }
  return null;
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
  zdfProbeDays = Number(process.env.ZDF_CATCHUP_PROBE_DAYS ?? 3),
  kodiFfmpegDirect = /^(1|true|yes)$/i.test(process.env.KODI_FFMPEGDIRECT ?? ''),
  logRequests = /^(1|true|yes)$/i.test(process.env.PROXY_LOG ?? ''),
  logger = console,
} = {}) {
  const zdfArchiveBoundaries = new Map();
  const catchupDays = { zdf: 1 };
  let configuredOrigin = null;
  if (publicOrigin) {
    const parsedOrigin = new URL(publicOrigin);
    if (!['http:', 'https:'].includes(parsedOrigin.protocol)) throw new Error('PUBLIC_ORIGIN must use http or https');
    configuredOrigin = parsedOrigin.origin;
  }
  const server = http.createServer(async (request, response) => {
    const requestOrigin = `http://${request.headers.host ?? 'localhost'}`;
    const proxyOrigin = configuredOrigin ?? requestOrigin;
    const requestUrl = new URL(request.url ?? '/', requestOrigin);
    if (requestUrl.pathname === '/health') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ ok: true }));
      return;
    }
    const catchupPath = requestUrl.pathname.match(/^\/catchup\/([^/]+)\/([^/]+)\/([^/]+)\.m3u8$/);
    const isCatchupRequest = requestUrl.pathname === '/catchup' || catchupPath !== null;
    const isFixedPlaylistRequest = requestUrl.pathname === '/playlist.m3u';
    if (requestUrl.pathname !== '/proxy' && !isCatchupRequest && !isFixedPlaylistRequest) {
      response.writeHead(404).end('Use GET /playlist.m3u or /proxy?url=https%3A%2F%2Fupstream%2Fplaylist.m3u8');
      return;
    }

    let target;
    try {
      const pathTarget = catchupPath ? Buffer.from(catchupPath[1], 'base64url').toString('utf8') : null;
      target = new URL(isFixedPlaylistRequest ? playlistUrl ?? '' : pathTarget ?? requestUrl.searchParams.get('url') ?? '');
    } catch {
      response.writeHead(isFixedPlaylistRequest ? 503 : 400).end(isFixedPlaylistRequest ? 'PLAYLIST_URL is not configured' : 'A valid url query parameter is required');
      return;
    }
    if (!allowedTarget(target, allowlist)) {
      response.writeHead(403).end('Upstream URL is not allowed');
      return;
    }
    const startedAt = Date.now();
    const log = (status, detail = '') => {
      if (!logRequests) return;
      // Do not log query parameters: playlist URLs frequently contain credentials.
      logger.info(`[proxy] ${request.method ?? 'GET'} ${requestUrl.pathname} ${status} ${target.origin}${target.pathname} ${Date.now() - startedAt}ms${detail ? ` ${detail}` : ''}`);
    };
    const start = Number(catchupPath ? catchupPath[2] : requestUrl.searchParams.get('start'));
    const duration = Number(catchupPath ? catchupPath[3] : requestUrl.searchParams.get('duration'));
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
        log(upstream.status, 'upstream-error');
        response.writeHead(upstream.status).end(`Upstream returned ${upstream.status}`);
        return;
      }
      if (isM3u8(target, contentType)) {
        const body = await upstream.text();
        const finalUrl = upstream.url || target.toString();
        let ranged = isCatchupRequest ? selectCatchupRange(body, start, duration) : body;
        if (isCatchupRequest) {
          const earliestSequence = await findZdfArchiveBoundary({
            playlist: body,
            sourceUrl: finalUrl,
            start,
            fetchImpl,
            cache: zdfArchiveBoundaries,
          });
          if (earliestSequence !== undefined) {
            ranged = zdfCatchupPlaylist({ playlist: body, sourceUrl: finalUrl, start, duration, earliestSequence });
          }
        }
        if (isCatchupRequest && ranged === null) {
          log(404, 'catchup-unavailable');
          response.writeHead(404).end('Requested catch-up window is not available');
          return;
        }
        const tagged = addCatchupTags(ranged, { catchupSeconds });
        // fetch follows redirects. Relative HLS URIs must be based on the final
        // response location, otherwise a redirected master playlist points its
        // video/audio renditions back at the pre-redirect host.
        const catchup = isCatchupRequest ? { start: String(start), duration: String(duration) } : null;
        let channelTagged = !body.includes('#EXT-X-') && !isCatchupRequest
          ? addCatchupChannelTags(tagged, finalUrl, proxyOrigin, (extinf) => /tvg-name="ZDF"/i.test(extinf) ? catchupDays.zdf : 1)
          : tagged;
        if (!body.includes('#EXT-X-') && !isCatchupRequest && kodiFfmpegDirect) channelTagged = addKodiFfmpegDirect(channelTagged);
        const rewritten = rewriteUris(channelTagged, finalUrl, proxyOrigin, catchup);
        response.writeHead(200, { 'content-type': 'application/vnd.apple.mpegurl; charset=utf-8', 'cache-control': 'no-store' });
        response.end(rewritten);
        log(200, isCatchupRequest ? 'catchup' : 'playlist');
      } else {
        response.writeHead(200, { 'content-type': contentType, 'cache-control': 'no-store' });
        response.end(Buffer.from(await upstream.arrayBuffer()));
        log(200, 'media');
      }
    } catch (error) {
      log(502, 'upstream-failure');
      response.writeHead(502).end(`Upstream request failed: ${error.message}`);
    } finally {
      clearTimeout(timeout);
    }
  });
  server.refreshCatchupDays = async () => {
    if (!playlistUrl) return catchupDays.zdf;
    try {
      const media = await resolveZdfMediaPlaylist({ playlistUrl, fetchImpl });
      if (!media) return catchupDays.zdf;
      const parsed = parseMediaSegments(media.playlist);
      const first = parsed.segments[0];
      const last = parsed.segments.at(-1);
      if (!first || !last || first.programTime === null || last.programTime === null) return catchupDays.zdf;
      const probeStart = first.programTime - Math.max(1, zdfProbeDays) * 24 * 60 * 60;
      const boundary = await findZdfArchiveBoundary({
        playlist: media.playlist,
        sourceUrl: media.sourceUrl,
        start: probeStart,
        fetchImpl,
        cache: zdfArchiveBoundaries,
      });
      if (boundary === undefined) return catchupDays.zdf;
      const archiveStart = first.programTime + (boundary - parsed.mediaSequence) * first.duration;
      catchupDays.zdf = Math.max(1, Math.ceil((last.programTime + last.duration - archiveStart) / (24 * 60 * 60)));
      if (logRequests) logger.info(`[proxy] discovered ZDF catch-up window: ${catchupDays.zdf} day(s)`);
      return catchupDays.zdf;
    } catch (error) {
      if (logRequests) logger.warn(`[proxy] ZDF catch-up discovery failed: ${error.message}`);
      return catchupDays.zdf;
    }
  };
  return server;
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
  server.listen(port, host, () => {
    console.log(`Catch-up M3U proxy listening on ${host ?? 'all interfaces'}:${port}`);
    server.refreshCatchupDays();
  });
}
