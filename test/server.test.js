import assert from 'node:assert/strict';
import test from 'node:test';
import { addCatchupChannelTags, addCatchupTags, addKodiFfmpegDirect, rewriteUris, selectCatchupRange, zdfCatchupPlaylist } from '../src/server.js';

const playlist = `#EXTM3U
#EXT-X-TARGETDURATION:60
#EXTINF:60,
one.ts
#EXTINF:60,
two.ts
#EXTINF:60,
three.ts
#EXTINF:60,
four.ts
#EXTINF:60,
six.ts
#EXTINF:60,
`;

test('does not add catch-up metadata for exactly five minutes', () => {
  assert.equal(addCatchupTags(playlist, { now: 1_000 }), playlist);
});

test('adds one program-date-time tag per chunk after five minutes', () => {
  const input = `${playlist}#EXTINF:60,\nsix.ts\n#EXTINF:60,\nseven.ts\n`;
  const output = addCatchupTags(input, { now: 1_000 });
  assert.equal((output.match(/#EXT-X-PROGRAM-DATE-TIME:/g) ?? []).length, 7);
  assert.match(output, /#EXT-X-PROGRAM-DATE-TIME:1970-01-01T00:15:40.000Z\n#EXTINF:60,\nseven\.ts/);
});

test('proxies relative media URIs', () => {
  const output = rewriteUris('#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="keys/key.bin"\nsegments/one.ts\n', 'https://origin.example/live/index.m3u8', 'http://localhost:8787');
  assert.match(output, /http:\/\/localhost:8787\/proxy\?url=https%3A%2F%2Forigin\.example%2Flive%2Fsegments%2Fone\.ts/);
  assert.match(output, /URI="http:\/\/localhost:8787\/proxy\?url=https%3A%2F%2Forigin\.example%2Flive%2Fkeys%2Fkey\.bin"/);
});

test('adds TiviMate and Kodi catch-up attributes to channel entries', () => {
  const output = addCatchupChannelTags('#EXTM3U\n#EXTINF:-1 tvg-id="one",One\nchannel.m3u8\n', 'https://origin.example/list.m3u', 'http://proxy.test:8787');
  assert.match(output, /catchup="default" catchup-days="1"/);
  assert.match(output, /catchup-source="http:\/\/proxy\.test:8787\/catchup\/aHR0cHM6Ly9vcmlnaW4uZXhhbXBsZS9jaGFubmVsLm0zdTg\/\{utc\}\/\{duration\}\.m3u8"/);
});

test('supports per-channel catch-up day declarations', () => {
  const output = addCatchupChannelTags('#EXTM3U\n#EXTINF:-1 tvg-name="ZDF",ZDF\nchannel.m3u8\n', 'https://origin.example/list.m3u', 'http://proxy.test:8787', () => 2);
  assert.match(output, /catchup-days="2"/);
});

test('adds Kodi ffmpegdirect inputstream properties per channel', () => {
  const output = addKodiFfmpegDirect('#EXTM3U\n#EXTINF:-1,One\none.m3u8\n#EXTINF:-1,Two\ntwo.m3u8\n');
  assert.equal((output.match(/#KODIPROP:inputstream=inputstream\.ffmpegdirect/g) ?? []).length, 2);
});

test('selects only the requested program range from a dated media playlist', () => {
  const source = `#EXTM3U\n#EXT-X-TARGETDURATION:60\n#EXT-X-PROGRAM-DATE-TIME:1970-01-01T00:00:00.000Z\n#EXTINF:60,\none.ts\n#EXT-X-PROGRAM-DATE-TIME:1970-01-01T00:01:00.000Z\n#EXTINF:60,\ntwo.ts\n`;
  const output = selectCatchupRange(source, 60, 60);
  assert.match(output, /two\.ts/);
  assert.doesNotMatch(output, /one\.ts/);
  assert.match(output, /#EXT-X-ENDLIST/);
});

test('keeps media chunks on the byte proxy while propagating catch-up to child playlists', () => {
  const output = rewriteUris('child.m3u8\nchunk.aac\n', 'https://origin.example/live/master.m3u8', 'http://proxy.test:8787', { start: '1', duration: '60' });
  assert.match(output, /\/catchup\?url=https%3A%2F%2Forigin\.example%2Flive%2Fchild\.m3u8&start=1&duration=60/);
  assert.match(output, /\/proxy\?url=https%3A%2F%2Forigin\.example%2Flive%2Fchunk\.aac/);
});

test('generates a ZDF catch-up playlist from numbered historical segments', () => {
  const source = `#EXTM3U\n#EXT-X-TARGETDURATION:2\n#EXT-X-MEDIA-SEQUENCE:100\n#EXT-X-PROGRAM-DATE-TIME:1970-01-01T00:03:20.000Z\n#EXTINF:2.000,\nhttps://zdf.example/100.ts\n#EXT-X-PROGRAM-DATE-TIME:1970-01-01T00:03:22.000Z\n#EXTINF:2.000,\nhttps://zdf.example/101.ts\n`;
  const output = zdfCatchupPlaylist({ playlist: source, sourceUrl: 'https://zdf.example/index.m3u8', start: 190, duration: 14, earliestSequence: 95 });
  assert.match(output, /#EXT-X-MEDIA-SEQUENCE:95/);
  assert.match(output, /https:\/\/zdf\.example\/95\.ts/);
  assert.match(output, /https:\/\/zdf\.example\/101\.ts/);
  assert.match(output, /#EXT-X-ENDLIST/);
});

test('returns unavailable when a ZDF program ends before the archive boundary', () => {
  const source = `#EXTM3U\n#EXT-X-MEDIA-SEQUENCE:100\n#EXT-X-PROGRAM-DATE-TIME:1970-01-01T00:03:20.000Z\n#EXTINF:2,\nhttps://zdf.example/100.ts\n`;
  assert.equal(zdfCatchupPlaylist({ playlist: source, sourceUrl: 'https://zdf.example/index.m3u8', start: 180, duration: 4, earliestSequence: 95 }), null);
});

test('generates numbered ZDF AAC catch-up segments for external audio renditions', () => {
  const source = `#EXTM3U\n#EXT-X-MEDIA-SEQUENCE:100\n#EXT-X-PROGRAM-DATE-TIME:1970-01-01T00:03:20.000Z\n#EXTINF:2,\nhttps://zdf.example/100.aac\n`;
  const output = zdfCatchupPlaylist({ playlist: source, sourceUrl: 'https://zdf.example/audio.m3u8', start: 190, duration: 4, earliestSequence: 95 });
  assert.match(output, /https:\/\/zdf\.example\/95\.aac/);
  assert.match(output, /#EXT-X-ENDLIST/);
});
