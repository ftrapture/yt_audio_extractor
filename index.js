import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { Transform } from "node:stream";
import { Logger } from "pastel-logger";

import {
  fetchTvHtml5Audio,
  fetchTvHtml5Muxed,
  getFormatCipherInfo,
  getPlaybackHeaders,
  isMuxedFormat,
  clearPlayerCache,
} from "./src/index.js";

const address = "0.0.0.0";
const port = 3030
const muxedCache = new Map();
const audioCache = new Map();
const logger = new Logger();

const RATE_LIMIT = 15;
const RATE_WINDOW_MS = 1000;
const rateBuckets = new Map();

function isRateLimited(ip) {
  const now = Date.now();
  const windowStart = now - RATE_WINDOW_MS;
  const timestamps = rateBuckets.get(ip) ?? [];
  const recent = timestamps.filter((t) => t > windowStart);
  recent.push(now);
  rateBuckets.set(ip, recent);
  return recent.length > RATE_LIMIT;
}

setInterval(() => {
  const cutoff = Date.now() - RATE_WINDOW_MS;
  for (const [ip, timestamps] of rateBuckets) {
    const recent = timestamps.filter((t) => t > cutoff);
    if (recent.length === 0) rateBuckets.delete(ip);
    else rateBuckets.set(ip, recent);
  }
}, 60_000).unref();

process.on("uncaughtException", (err) => {
  logger.warn(`[yt-cipher] uncaught exception:\n${err.message ?? JSON.stringify(err)}`);
});
process.on("unhandledRejection", (reason) => {
  logger.warn(`[yt-cipher] unhandled rejection:\n${JSON.stringify(reason)}`);
});

function getRequestProto(req) {
  const forwarded = req.headers["x-forwarded-proto"];
  if (forwarded) return forwarded.split(",")[0].trim();
  return req.socket?.encrypted ? "https" : "http";
}

const server = createServer(async (req, res) => {
  const proto = getRequestProto(req);
  const host = req.headers.host ?? `${address}:${port}`;
  const url = new URL(req.url, `${proto}://${host}`);
  logger.log(`[yt-cipher] ${req.method} ${req.url} (range: ${req.headers.range || "none"})`);

  const clientIp = (req.headers["x-forwarded-for"] ?? req.socket.remoteAddress ?? "unknown").split(",")[0].trim();

  if (isRateLimited(clientIp)) {
    res.writeHead(429, {
      "access-control-allow-origin": "*",
      "content-type": "application/json; charset=utf-8",
      "retry-after": "1",
    });
    res.end(JSON.stringify({ error: "rate limit exceeded — max 30 requests/sec per IP" }) + "\n");
    return;
  }

  try {
    if (req.method === "OPTIONS") {
      sendJson(res, 204, null);
      return;
    }

    if (req.method !== "GET" && req.method !== "HEAD") {
      sendJson(res, 405, { error: "only get and head are supported" });
      return;
    }

    if (url.pathname === "/health") {
      sendJson(res, 200, { ok: true });
      return;
    }

    if (url.pathname === "/resolve") {
      const videoId = extractVideoId(
        url.searchParams.get("video") ?? url.searchParams.get("url") ?? url.searchParams.get("id"),
      );
      const mode = url.searchParams.get("mode") ?? "muxed";

      if (!videoId) {
        sendJson(res, 400, { error: "missing video id or url try /resolve?video=<youtube-url-or-id>" });
        return;
      }

      const formats = url.searchParams.get("formats") === "1";

      if (mode === "audio") {
        sendJson(res, 200, await resolveAudioOnly(videoId, { formats }));
        return;
      }

      if (mode !== "muxed") {
        sendJson(res, 400, { error: "mode must be 'muxed' or 'audio'" });
        return;
      }

      sendJson(res, 200, await resolveMuxed(videoId, { formats, requestUrl: url }));
      return;
    }

    if (url.pathname === "/audio") {
      const videoId = extractVideoId(
        url.searchParams.get("video") ?? url.searchParams.get("url") ?? url.searchParams.get("id"),
      );
      const format = url.searchParams.get("format") ?? "mp3";
      const bitrate = url.searchParams.get("bitrate") ?? "128k";

      logger.log(`[yt-cipher] /audio videoId=${videoId} format=${format} bitrate=${bitrate} ip=${req.socket.remoteAddress}`);

      if (!videoId) {
        sendJson(res, 400, { error: "missing video id or url — try /audio?video=<youtube-url-or-id>" });
        return;
      }

      if (req.method === "HEAD") {
        const meta = await buildStreamMetadata(videoId, url, req);
        res.writeHead(meta.statusCode, meta.headers);
        res.end();
        return;
      }

      await streamAudio(videoId, url, req, res);
      return;
    }

    sendJson(res, 404, {
      error: "not found",
      routes: [
        "/health",
        "/resolve?video=<youtube-url-or-id>&mode=muxed",
        "/audio?video=<youtube-url-or-id>&format=mp3",
      ],
    });
  } catch (err) {
    sendJson(res, 500, {
      error: err instanceof Error ? err.message : String(err),
      stack: err.stack,
    });
  }
});

server.listen(port, address, () => {
  logger.info(`yt_audio_extractor listening on http://${address}:${port}`);
  logger.info(`resolve: http://${address}:${port}/resolve?video=JBA6DzhJxNY`);
  logger.info(`stream audio: http://${address}:${port}/audio?video=JBA6DzhJxNY&format=mp3`);
});

async function resolveMuxed(videoId, options = {}) {
  const result = await getMuxed(videoId);
  const playingStatus = readplayingStatus(result.playerResponse);

  if (!result.bestMuxed || !result.playableUrl) {
    return {
      ok: false,
      videoId,
      mode: "muxed",
      playingStatus,
      error: "no muxed video+audio format was returned for this video/client",
      extractable: false,
      note: "not every video exposes a muxed stream private, restricted, live/SABR-only, region-locked, or DRM-protected videos may fail",
    };
  }

  const format = result.bestMuxed;

  const response = {
    ok: playingStatus.status === "OK",
    extractable: playingStatus.status === "OK",
    videoId,
    mode: "muxed",
    delivery: "url-only",
    media: {
      url: result.playableUrl,
      headers: {},
      probeHeaders: getPlaybackHeaders(format, { range: "bytes=0-1" }),
      expiresAt: readExpireTimestamp(result.playableUrl),
      format: toPlainFormat(format),
      containsAudio: true,
      containsVideo: true,
      demuxRequired: true,
    },
    pipeline: {
      type: "muxed-video-audio",
      instruction: "use audioStreamUrl for serverside demuxed audio, or pull media.url into your own pipeline",
      audioStreamUrl: buildAudioStreamUrl(options.requestUrl, videoId),
      args: ["-i", result.playableUrl, "-vn", "-c:a", "copy", "output.m4a"],
    },
    cipher: getFormatCipherInfo(format),
    playingStatus,
    limits: extractionLimits(),
  };

  if (options.formats) {
    response.allFormats = listAllFormats(result.solvedResponse);
  }

  return response;
}

async function resolveAudioOnly(videoId, options = {}) {
  const result = await fetchTvHtml5Audio(videoId, { range: "bytes=0-1" });
  const playingStatus = readplayingStatus(result.playerResponse);

  if (!result.bestAudio || !result.playableUrl) {
    return {
      ok: false,
      videoId,
      mode: "audio",
      playingStatus,
      error: "no audio only format was returned for this video/client",
      extractable: false,
      note: "try mode=muxed and demux audio from the progressive stream instead",
    };
  }

  const format = result.bestAudio;

  const response = {
    ok: playingStatus.status === "OK",
    extractable: playingStatus.status === "OK",
    videoId,
    mode: "audio",
    delivery: "url-only",
    media: {
      url: result.playableUrl,
      headers: getPlaybackHeaders(format, { range: "bytes=0-1" }),
      expiresAt: readExpireTimestamp(result.playableUrl),
      format: toPlainFormat(format),
      containsAudio: true,
      containsVideo: false,
      demuxRequired: false,
    },
    pipeline: {
      type: "adaptive-audio",
      instruction: "use media.url with media.headers adaptive audio can reject a bare GET with no headers",
    },
    cipher: getFormatCipherInfo(format),
    playingStatus,
    limits: extractionLimits(),
  };

  if (options.formats) {
    response.allFormats = listAllFormats(result.solvedResponse);
  }

  return response;
}

async function streamAudio(videoId, requestUrl, req, res) {
  logger.log(`[yt-cipher] resolving stream for ${videoId}`);
  const meta = await buildStreamMetadata(videoId, requestUrl, req);
  const { output, result, timeSeek, maxBytes } = meta;
  const playingStatus = readplayingStatus(result.playerResponse);

  if (playingStatus.status !== "OK" || (!result.bestMuxed && !result.bestAudio) || !result.playableUrl) {
    logger.error(`[yt-cipher] can't stream ${videoId}: status=${playingStatus.status} muxed=${!!result.bestMuxed} audio=${!!result.bestAudio}`);
    sendJson(res, 422, {
      ok: false,
      videoId,
      playingStatus,
      error: "no playable stream is available for this video",
      limits: extractionLimits(),
    });
    return;
  }

  if (meta.statusCode === 416) {
    res.writeHead(416, meta.headers);
    res.end();
    return;
  }

  const sourceUrl = stripRangeParam(result.playableUrl);

  const args = buildargs(sourceUrl, output, {
    startSeconds: timeSeek.startSeconds,
    durationSeconds: timeSeek.durationSeconds,
    headers: stripRangeHeaders(result.playbackHeaders),
  });

  const bin = resolvebin();
  const child = spawnFfmpeg(bin, args);

  if (!child) {
    sendJson(res, 500, {
      ok: false,
      error: `couldn't find ffmpeg at "${bin}" install ffmpeg or set FFMPEG_PATH`,
    });
    return;
  }

  logger.log(`[yt-cipher] spawning ffmpeg for ${videoId}: ${sourceUrl.slice(0, 100)}...`);

  let headersSent = false;
  let stoppedByByteLimit = false;
  const stderrChunks = [];
  const MAX_STDERR_CHUNKS = 20;

  const killFfmpeg = () => {
    if (child.killed) return;
    try {
      child.stdout.destroy();
    } catch { }
    child.kill("SIGKILL");
  };

  req.on("close", killFfmpeg);
  res.on("close", killFfmpeg);
  res.on("error", (err) => logger.warn(`[yt-cipher] response socket error for ${videoId}:\n${JSON.stringify(err.message)}`));

  child.stderr.on("data", (chunk) => {
    if (stderrChunks.length < MAX_STDERR_CHUNKS) {
      stderrChunks.push(chunk);
    }
  });

  child.stdout.once("data", (firstChunk) => {
    headersSent = true;
    const sourceFormat = result.bestMuxed ?? result.bestAudio;

    res.writeHead(meta.statusCode, {
      ...meta.headers,
      "x-yt-cipher-video-id": videoId,
      "x-yt-cipher-source-itag": String(sourceFormat.itag),
      "x-yt-cipher-demuxed": "true",
      "x-yt-cipher-seek-seconds": String(timeSeek.startSeconds),
    });

    child.stdout.on("error", () => killFfmpeg());

    if (maxBytes == null) {
      res.write(firstChunk);
      child.stdout.pipe(res);
      return;
    }

    const limiter = createByteLimiter(maxBytes, () => {
      stoppedByByteLimit = true;
      killFfmpeg();
    });
    limiter.on("error", () => killFfmpeg());
    limiter.pipe(res);
    limiter.write(firstChunk);
    child.stdout.pipe(limiter);
  });

  child.once("error", (err) => {
    logger.error(`[yt-cipher] ffmpeg failed to start for ${videoId}:\n${err.message}`);
    if (!headersSent && !res.headersSent) {
      sendJson(res, 500, { ok: false, error: `failed to start ffmpeg: ${err.message}` });
    } else {
      res.destroy();
    }
  });

  child.once("exit", (code, signal) => {
    req.off("close", killFfmpeg);
    res.off("close", killFfmpeg);
    logger.log(`[yt-cipher] ffmpeg exited for ${videoId}: code=${code} signal=${signal} byteLimit=${stoppedByByteLimit}`);

    const endedCleanly = code === 0 || stoppedByByteLimit || child.killed || signal === "SIGKILL";
    if (endedCleanly) {
      if (!res.destroyed) res.end();
      return;
    }

    logger.warn(`[yt-cipher] clearing caches for ${videoId} after ffmpeg failure`);
    muxedCache.delete(videoId);
    audioCache.delete(videoId);
    clearPlayerCache();

    if (!headersSent && !res.headersSent) {
      const errorDetails = Buffer.concat(stderrChunks).toString("utf8").slice(0, 2000);
      logger.error(`[yt-cipher] ffmpeg stderr for ${videoId}:\n${errorDetails}`);
      sendJson(res, 500, { ok: false, error: `ffmpeg exited with code ${code}`, details: errorDetails });
    } else if (!res.destroyed) {
      res.destroy();
    }
  });
}

async function buildStreamMetadata(videoId, requestUrl, req) {
  const output = readAudioOutputOptions(requestUrl);
  const result = await getMuxedOrAudio(videoId);
  const durationSeconds = readDurationSeconds(result);
  const range = parseRangeHeader(req.headers.range);

  if (output.format !== "mp3" || !durationSeconds) {
    return {
      output,
      result,
      range: null,
      timeSeek: { startSeconds: 0, durationSeconds: null },
      maxBytes: null,
      statusCode: 200,
      headers: audioResponseHeaders(output),
    };
  }

  const bytesPerSecond = readBytesPerSecond(output.bitrate);
  const totalBytes = Math.max(1, Math.ceil(durationSeconds * bytesPerSecond));
  const normalizedRange = range ? clampRangeToLength(range, totalBytes) : null;

  if (range && !normalizedRange) {
    return {
      output,
      result,
      range: null,
      timeSeek: { startSeconds: 0, durationSeconds: null },
      maxBytes: 0,
      statusCode: 416,
      headers: {
        ...audioResponseHeaders(output),
        "content-range": `bytes */${totalBytes}`,
        "content-length": "0",
      },
    };
  }

  const startByte = normalizedRange?.start ?? 0;
  const endByte = normalizedRange?.end ?? totalBytes - 1;
  const rangeByteCount = endByte - startByte + 1;

  const startSeconds = normalizedRange ? Math.max(0, (startByte / totalBytes) * durationSeconds) : 0;
  const remainingSeconds = Math.max(0, durationSeconds - startSeconds);
  const isOpenEndedRange = Boolean(range && range.start != null && range.end == null);
  const hasKnownEnd = Boolean(normalizedRange && !isOpenEndedRange);

  return {
    output,
    result,
    range: normalizedRange,
    timeSeek: {
      startSeconds,
      durationSeconds: hasKnownEnd ? rangeByteCount / bytesPerSecond : null,
    },
    maxBytes: hasKnownEnd ? rangeByteCount : null,
    statusCode: normalizedRange ? 206 : 200,
    headers: {
      ...audioResponseHeaders(output),
      "accept-ranges": "bytes",
      "x-content-duration": String(Math.round(remainingSeconds * 1000) / 1000),
      "x-duration": String(durationSeconds),
      "content-length": String(rangeByteCount),
      ...(normalizedRange ? { "content-range": `bytes ${startByte}-${totalBytes - 1}/${totalBytes}` } : {}),
    },
  };
}

async function getMuxed(videoId) {
  const cached = muxedCache.get(videoId);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.result;
  }

  const result = await fetchTvHtml5Muxed(videoId);
  cacheIfUsable(muxedCache, videoId, result);
  return result;
}

async function getAudioOnly(videoId) {
  const cached = audioCache.get(videoId);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.result;
  }

  const result = await fetchTvHtml5Audio(videoId);
  cacheIfUsable(audioCache, videoId, result);
  return result;
}

function cacheIfUsable(cache, videoId, result) {
  if (!result.playableUrl) return;

  const urlExpiresAt = readExpireTimestamp(result.playableUrl);
  const FIVE_MINUTES = 5 * 60_000;
  const FIFTEEN_MINUTES = 15 * 60_000;

  const expiresAt = Math.min(
    urlExpiresAt ? urlExpiresAt - 60_000 : Date.now() + FIVE_MINUTES,
    Date.now() + FIFTEEN_MINUTES,
  );

  if (expiresAt > Date.now()) {
    cache.set(videoId, { result, expiresAt });
  }
}

async function getMuxedOrAudio(videoId) {
  try {
    const muxed = await getMuxed(videoId);
    if (muxed.playableUrl) {
      return { ...muxed, bestAudio: muxed.bestMuxed ?? muxed.bestAudio ?? null };
    }
  } catch { }
  return getAudioOnly(videoId);
}

function resolvebin() {
  const isWindows = process.platform === "win32";
  return isWindows ? "ffmpeg.exe" : "ffmpeg";
}

function spawnFfmpeg(binary, args) {
  const isWindows = process.platform === "win32";
  try {
    return spawn(binary, args, {
      stdio: ["ignore", "pipe", "pipe"],
      ...(isWindows ? { windowsHide: true } : {}),
    });
  } catch {
    return null;
  }
}

function buildargs(inputUrl, output, seek = {}) {
  const headerLines = seek.headers
    ? Object.entries(seek.headers).map(([key, value]) => `${key}: ${value}`).join("\r\n") + "\r\n"
    : "";

  const sharedArgs = [
    "-hide_banner",
    "-loglevel", "error",
    "-nostdin",
    "-probesize", "32768",
    "-analyzeduration", "0",
    ...(headerLines ? ["-headers", headerLines] : []),
    ...(seek.startSeconds ? ["-ss", String(seek.startSeconds)] : []),
    "-reconnect", "1",
    "-reconnect_at_eof", "1",
    "-reconnect_streamed", "1",
    "-reconnect_delay_max", "5",
    "-multiple_requests", "1",
    "-i", inputUrl,
    ...(seek.durationSeconds ? ["-t", String(seek.durationSeconds)] : []),
    "-vn",
    "-map", "0:a:0",
  ];

  if (output.format === "mp3") {
    return [...sharedArgs, "-c:a", "libmp3lame", "-b:a", output.bitrate, "-write_xing", "0", "-flush_packets", "1", "-f", "mp3", "pipe:1"];
  }

  if (output.format === "aac") {
    return [...sharedArgs, "-c:a", "aac", "-b:a", output.bitrate, "-flush_packets", "1", "-f", "adts", "pipe:1"];
  }

  if (output.format === "opus") {
    return [...sharedArgs, "-c:a", "libopus", "-b:a", output.bitrate, "-flush_packets", "1", "-f", "ogg", "pipe:1"];
  }

  return [...sharedArgs, "-c:a", "copy", "-f", "mp4", "-movflags", "frag_keyframe+empty_moov+default_base_moof", "pipe:1"];
}

function readAudioOutputOptions(requestUrl) {
  const format = (requestUrl.searchParams.get("format") ?? "mp3").toLowerCase();
  const bitrate = requestUrl.searchParams.get("bitrate") ?? "128k";

  const supportedFormats = ["mp3", "aac", "opus", "m4a"];
  if (!supportedFormats.includes(format)) logger.error(`[yt-cipher] invalid audio format "${format}" use one of: ${supportedFormats.join(", ")}`);
  if (!/^\d+(\.\d+)?k?$/i.test(bitrate)) logger.error(`[yt-cipher] invalid bitrate "${bitrate}" expected something like "128k" or "192k"`);

  return { format, bitrate };
}

function audioResponseHeaders(output) {
  const contentTypeByFormat = {
    mp3: "audio/mpeg",
    aac: "audio/aac",
    opus: "audio/ogg; codecs=opus",
    m4a: "audio/mp4",
  };
  const fileExtension = output.format === "opus" ? "ogg" : output.format;

  return {
    "access-control-allow-origin": "*",
    "access-control-expose-headers": "accept-ranges, content-length, content-range, x-content-duration, x-duration, x-yt-cipher-seek-seconds",
    "cache-control": "no-store",
    "content-type": contentTypeByFormat[output.format],
    "content-disposition": `inline; filename="audio.${fileExtension}"`,
  };
}

function buildAudioStreamUrl(requestUrl, videoId) {
  const origin = requestUrl ? `${requestUrl.protocol}//${requestUrl.host}` : `http://${address}:${port}`;
  return `${origin}/audio?video=${encodeURIComponent(videoId)}&format=mp3`;
}

function stripRangeParam(rawUrl) {
  try {
    const parsed = new URL(rawUrl);
    parsed.searchParams.delete("range");
    return parsed.toString();
  } catch {
    return rawUrl;
  }
}

function stripRangeHeaders(headers = {}) {
  return Object.fromEntries(Object.entries(headers).filter(([key]) => key.toLowerCase() !== "range"));
}

function readDurationSeconds(result) {
  let urlDuration = null;
  if (result.playableUrl) {
    try {
      urlDuration = Number(new URL(result.playableUrl).searchParams.get("dur"));
    } catch { }
  }

  const bestGuess =
    (Number.isFinite(urlDuration) && urlDuration > 0 ? urlDuration : null) ??
    result.playerResponse?.videoDetails?.lengthSeconds ??
    (result.bestMuxed?.approxDurationMs ? Number(result.bestMuxed.approxDurationMs) / 1000 : null) ??
    (result.bestAudio?.approxDurationMs ? Number(result.bestAudio.approxDurationMs) / 1000 : null);

  const duration = Number(bestGuess);
  return Number.isFinite(duration) && duration > 0 ? duration : null;
}

function readBytesPerSecond(bitrate) {
  const match = String(bitrate).match(/^(\d+(?:\.\d+)?)(k?)$/i);
  if (!match) {
    return 128_000 / 8;
  }
  const isKilobits = match[2].toLowerCase() === "k";
  const bitsPerSecond = Number(match[1]) * (isKilobits ? 1000 : 1);
  return Math.max(1, bitsPerSecond / 8);
}

function parseRangeHeader(header) {
  if (!header) return null;
  const match = String(header).match(/^bytes=(\d*)-(\d*)$/);
  if (!match) return null;
  return {
    start: match[1] ? Number(match[1]) : null,
    end: match[2] ? Number(match[2]) : null,
  };
}

function clampRangeToLength(range, totalBytes) {
  let { start, end } = range;

  if (start == null && end == null) {
    return null;
  }

  if (start == null) {
    const suffixLength = Math.max(0, end ?? 0);
    start = Math.max(0, totalBytes - suffixLength);
    end = totalBytes - 1;
  } else if (end == null) {
    end = totalBytes - 1;
  }

  start = Math.max(0, start);
  end = Math.min(totalBytes - 1, end);

  if (start > end || start >= totalBytes) {
    return null;
  }

  return { start, end };
}

function createByteLimiter(maxBytes, onLimitReached) {
  let bytesSent = 0;
  return new Transform({
    transform(chunk, _encoding, callback) {
      if (bytesSent >= maxBytes) {
        callback();
        return;
      }

      const bytesLeft = maxBytes - bytesSent;
      const piece = chunk.length > bytesLeft ? chunk.subarray(0, bytesLeft) : chunk;
      bytesSent += piece.length;
      this.push(piece);

      if (bytesSent >= maxBytes) {
        onLimitReached();
      }

      callback();
    },
  });
}

function listAllFormats(playerResponse) {
  const formats = [
    ...(playerResponse.streamingData?.formats ?? []),
    ...(playerResponse.streamingData?.adaptiveFormats ?? []),
  ];

  return formats.map((format) => ({
    ...toPlainFormat(format),
    muxed: isMuxedFormat(format),
    cipher: getFormatCipherInfo(format),
  }));
}

function toPlainFormat(format) {
  return {
    itag: format.itag,
    mimeType: format.mimeType,
    bitrate: format.bitrate ?? null,
    averageBitrate: format.averageBitrate ?? null,
    contentLength: format.contentLength ?? null,
    audioChannels: format.audioChannels ?? null,
    width: format.width ?? null,
    height: format.height ?? null,
    fps: format.fps ?? null,
    qualityLabel: format.qualityLabel ?? null,
    audioQuality: format.audioQuality ?? null,
  };
}

function readplayingStatus(playerResponse) {
  return {
    status: playerResponse?.playabilityStatus?.status ?? null,
    reason: playerResponse?.playabilityStatus?.reason ?? null,
  };
}

function readExpireTimestamp(rawUrl) {
  try {
    const expire = Number(new URL(rawUrl).searchParams.get("expire"));
    return Number.isFinite(expire) ? expire * 1000 : null;
  } catch {
    return null;
  }
}

function extractionLimits() {
  return {
    everyVideoExtractable: false,
    reasons: [
      "private or deleted video",
      "members-only or account-restricted video",
      "age or region restrictions",
      "DRM/protected playback",
      "live/SABR-only responses",
      "client does not receive muxed formats",
    ],
  };
}

function sendJson(res, status, data) {
  res.writeHead(status, {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET, OPTIONS",
    "access-control-allow-headers": "content-type, authorization",
    "content-type": "application/json; charset=utf-8",
  });
  res.end(data == null ? undefined : `${JSON.stringify(data, null, 2)}\n`);
}

function extractVideoId(input) {
  if (!input) return null;

  if (/^[a-zA-Z0-9_-]{11}$/.test(input)) {
    return input;
  }

  try {
    const parsed = new URL(input);
    if (parsed.addressname === "youtu.be") {
      return parsed.pathname.split("/").filter(Boolean)[0] ?? null;
    }
    return parsed.searchParams.get("v") ?? parsed.pathname.match(/\/shorts\/([^/?#]+)/)?.[1] ?? null;
  } catch {
    return null;
  }
}