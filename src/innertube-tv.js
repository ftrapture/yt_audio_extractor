import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import {
  extractSignatureTimestamp,
  fetchPlayerJs,
  fetchPlayerMetadataFromWatch,
  getPlaybackHeaders,
  selectAudioFormats,
  selectBestAudioFormat,
  selectBestMuxedFormat,
  selectMuxedFormats,
  solvePlayerResponse,
} from "./cipher.js";

export const DEFAULT_TOKEN_PATH = resolve(".tokens", "youtube-tv-oauth.json");

export const TVHTML5_CLIENT = {
  clientName: "TVHTML5",
  clientVersion: "7.20260114.12.00",
  userAgent:
    "Mozilla/5.0 (ChromiumStylePlatform) Cobalt/25.lts.30.1034943-gold (unlike Gecko), Unknown_TV_Unknown_0/Unknown (Unknown, Unknown)",
  playerParams: "2AMB",
};

const DEFAULT_OAUTH = {
  clientId:
    "861556708454-d6dlm3lh05idd8npek18k6be8ba3oc68.apps.googleusercontent.com",
  clientSecret: "SboVhoG9s0rNafixCSGGKXAT",
  scope: "http://gdata.youtube.com https://www.googleapis.com/auth/youtube",
};

const DEVICE_CODE_URL = "https://www.youtube.com/o/oauth2/device/code";
const TOKEN_URL = "https://www.youtube.com/o/oauth2/token";
const PLAYER_URL = "https://youtubei.googleapis.com/youtubei/v1/player?prettyPrint=false";

export async function loadTokenStore(path = DEFAULT_TOKEN_PATH) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

export async function saveTokenStore(tokens, path = DEFAULT_TOKEN_PATH) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(tokens, null, 2)}\n`, "utf8");
}

export async function getTvAccessToken(options = {}) {
  const tokenPath = options.tokenPath ?? DEFAULT_TOKEN_PATH;
  const oauth = normalizeOAuthOptions(options);
  const now = Date.now();
  const cached = options.forceDeviceFlow ? null : await loadTokenStore(tokenPath);

  if (cached?.access_token && cached.expires_at && now < cached.expires_at - 60_000) {
    return cached;
  }

  if (cached?.refresh_token && !options.forceDeviceFlow) {
    try {
      const refreshed = await refreshTvAccessToken(cached.refresh_token, oauth, options);
      const merged = {
        ...cached,
        ...refreshed,
        refresh_token: refreshed.refresh_token ?? cached.refresh_token,
      };
      await saveTokenStore(merged, tokenPath);
      return merged;
    } catch (error) {
      if (!options.allowDeviceFallback) {
        throw error;
      }
      console.warn(`Refreshing cached YouTube OAuth token failed: ${error.message}`);
    }
  }

  const tokens = await runDeviceFlow(oauth, options);
  await saveTokenStore(tokens, tokenPath);
  return tokens;
}

export async function refreshTvAccessToken(refreshToken, oauth = {}, options = {}) {
  const body = {
    client_id: oauth.clientId ?? DEFAULT_OAUTH.clientId,
    client_secret: oauth.clientSecret ?? DEFAULT_OAUTH.clientSecret,
    refresh_token: refreshToken,
    grant_type: "refresh_token",
  };

  const json = await postJson(TOKEN_URL, body, options);
  assertOAuthSuccess(json, "refresh access token");
  return withExpiry(json);
}

export async function fetchTvHtml5Player(videoId, options = {}) {
  if (!videoId) {
    throw new Error("videoId is required");
  }

  const token = options.accessToken
    ? { access_token: options.accessToken, token_type: "Bearer" }
    : await getTvAccessToken({
        ...options,
        allowDeviceFallback: true,
      });

  const playerMetadata = options.playerMetadata ?? await fetchPlayerMetadataFromWatch(videoId, options);
  const playerJs = options.playerJs ?? await fetchPlayerJs(playerMetadata.playerUrl, options);
  const signatureTimestamp =
    options.signatureTimestamp ??
    playerMetadata.signatureTimestamp ??
    extractSignatureTimestamp(playerJs);
  const visitorData = options.visitorData ?? playerMetadata.visitorData;

  const payload = {
    context: {
      client: {
        clientName: TVHTML5_CLIENT.clientName,
        clientVersion: TVHTML5_CLIENT.clientVersion,
        hl: options.hl ?? "en",
        gl: options.gl ?? "US",
        ...(visitorData ? { visitorData } : {}),
      },
    },
    playbackContext: {
      contentPlaybackContext: {
        signatureTimestamp: Number(signatureTimestamp),
      },
    },
    videoId,
    params: options.params ?? TVHTML5_CLIENT.playerParams,
    racyCheckOk: true,
    contentCheckOk: true,
  };

  if (options.debugPayload) {
    console.error(JSON.stringify({
      playerUrl: playerMetadata.playerUrl,
      signatureTimestamp,
      visitorData: visitorData ? "[present]" : null,
      payload,
    }, null, 2));
  }

  const res = await (options.fetch ?? fetch)(PLAYER_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "accept-language": `${options.hl ?? "en"}-${options.gl ?? "US"},${options.hl ?? "en"};q=0.9`,
      "user-agent": TVHTML5_CLIENT.userAgent,
      "authorization": `${token.token_type ?? "Bearer"} ${token.access_token}`,
      "origin": "https://www.youtube.com",
      ...(visitorData ? { "x-goog-visitor-id": visitorData } : {}),
      ...(options.headers ?? {}),
    },
    body: JSON.stringify(payload),
  });

  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`Innertube player returned non-JSON (${res.status}): ${text.slice(0, 300)}`);
  }

  if (!res.ok) {
    throw new Error(`Innertube player failed (${res.status} ${res.statusText}): ${JSON.stringify(json)}`);
  }

  return json;
}

export async function fetchTvHtml5Audio(videoId, options = {}) {
  const playerResponse = await fetchTvHtml5Player(videoId, options);
  const solvedResponse = await solvePlayerResponse(playerResponse, {
    ...options,
    videoId,
    client: "tv",
  });
  const audioFormats = selectAudioFormats(solvedResponse, options);
  const bestAudio = selectBestAudioFormat(audioFormats, options);

  return {
    videoId,
    playerResponse,
    solvedResponse,
    audioFormats,
    bestAudio,
    playableUrl: bestAudio?.playableUrl ?? bestAudio?.url ?? null,
    playbackHeaders: bestAudio
      ? getPlaybackHeaders(bestAudio, {
          userAgent: TVHTML5_CLIENT.userAgent,
          ...options,
        })
      : null,
  };
}

export async function fetchTvHtml5Muxed(videoId, options = {}) {
  const playerResponse = await fetchTvHtml5Player(videoId, options);
  const solvedResponse = await solvePlayerResponse(playerResponse, {
    ...options,
    videoId,
    client: "tv",
  });
  const muxedFormats = selectMuxedFormats(solvedResponse, options);
  const bestMuxed = selectBestMuxedFormat(muxedFormats, options);

  return {
    videoId,
    playerResponse,
    solvedResponse,
    muxedFormats,
    bestMuxed,
    playableUrl: bestMuxed?.playableUrl ?? bestMuxed?.url ?? null,
    playbackHeaders: bestMuxed
      ? getPlaybackHeaders(bestMuxed, {
          userAgent: TVHTML5_CLIENT.userAgent,
          ...options,
        })
      : null,
  };
}

async function runDeviceFlow(oauth, options = {}) {
  const device = await postJson(
    DEVICE_CODE_URL,
    {
      client_id: oauth.clientId,
      scope: oauth.scope,
      device_id: randomUUID().replaceAll("-", ""),
      device_model: "ytlr::",
    },
    options,
  );

  assertOAuthSuccess(device, "request device code");
  const verificationUrl = device.verification_url ?? "https://www.google.com/device";
  const intervalMs = Math.max(Number(device.interval ?? 5), 1) * 1000;

  const onPending = options.onDeviceCode ?? defaultDeviceCodeLogger;
  onPending({
    verification_url: verificationUrl,
    user_code: device.user_code,
    expires_in: device.expires_in,
  });

  let pollIntervalMs = intervalMs;
  const startedAt = Date.now();
  const expiresAt = startedAt + Number(device.expires_in ?? 900) * 1000;

  while (Date.now() < expiresAt) {
    await sleep(pollIntervalMs);
    const token = await postJson(
      TOKEN_URL,
      {
        client_id: oauth.clientId,
        client_secret: oauth.clientSecret,
        code: device.device_code,
        grant_type: "http://oauth.net/grant_type/device/1.0",
      },
      {
        ...options,
        throwOnHttpError: false,
      },
    );

    if (!token.error) {
      return withExpiry(token);
    }

    if (token.error === "authorization_pending") {
      continue;
    }
    if (token.error === "slow_down") {
      pollIntervalMs += 5000;
      continue;
    }
    if (token.error === "expired_token") {
      throw new Error("Device code expired before authorization completed");
    }
    if (token.error === "access_denied") {
      throw new Error("User denied YouTube OAuth authorization");
    }

    throw new Error(`Unhandled OAuth polling error: ${token.error}`);
  }

  throw new Error("Device code expired before authorization completed");
}

function normalizeOAuthOptions(options) {
  return {
    clientId:
      options.clientId ??
      process.env.YOUTUBE_OAUTH_CLIENT_ID ??
      DEFAULT_OAUTH.clientId,
    clientSecret:
      options.clientSecret ??
      process.env.YOUTUBE_OAUTH_CLIENT_SECRET ??
      DEFAULT_OAUTH.clientSecret,
    scope:
      options.scope ??
      process.env.YOUTUBE_OAUTH_SCOPE ??
      DEFAULT_OAUTH.scope,
  };
}

async function postJson(url, body, options = {}) {
  const res = await (options.fetch ?? fetch)(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "user-agent": TVHTML5_CLIENT.userAgent,
      ...(options.headers ?? {}),
    },
    body: JSON.stringify(body),
  });

  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`${url} returned non-JSON (${res.status}): ${text.slice(0, 300)}`);
  }

  if (!res.ok && options.throwOnHttpError !== false) {
    throw new Error(`${url} failed (${res.status} ${res.statusText}): ${JSON.stringify(json)}`);
  }

  return json;
}

function assertOAuthSuccess(json, context) {
  if (json.error) {
    throw new Error(`OAuth ${context} failed: ${json.error_description ?? json.error}`);
  }
}

function withExpiry(tokens) {
  const expiresIn = Number(tokens.expires_in ?? 300);
  return {
    ...tokens,
    expires_at: Date.now() + expiresIn * 1000,
    created_at: Date.now(),
  };
}

function defaultDeviceCodeLogger(data) {
  console.log("");
  console.log("YouTube TV OAuth authorization required");
  console.log("Use a browser to open:");
  console.log(`  ${data.verification_url}`);
  console.log("Then enter this code:");
  console.log(`  ${data.user_code}`);
  console.log("");
}

function sleep(ms) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}
