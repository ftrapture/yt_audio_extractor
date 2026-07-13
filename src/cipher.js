import { generate } from "astring";
import { parse } from "meriyah";

const YOUTUBE_ORIGIN = "https://www.youtube.com";
const playerCache = new Map();

const setupNodes = parse(`
if (typeof globalThis.XMLHttpRequest === "undefined") {
  globalThis.XMLHttpRequest = { prototype: {} };
}
if (typeof URL === "undefined") {
  globalThis.location = {
    hash: "",
    host: "www.youtube.com",
    hostname: "www.youtube.com",
    href: "https://www.youtube.com/watch?v=JBA6DzhJxNY",
    origin: "https://www.youtube.com",
    password: "",
    pathname: "/watch",
    port: "",
    protocol: "https:",
    search: "?v=JBA6DzhJxNY",
    username: ""
  };
} else {
  globalThis.location = new URL("https://www.youtube.com/watch?v=JBA6DzhJxNY");
}
if (typeof globalThis.document === "undefined") {
  globalThis.document = Object.create(null);
}
if (typeof globalThis.navigator === "undefined") {
  globalThis.navigator = Object.create(null);
}
if (typeof globalThis.self === "undefined") {
  globalThis.self = globalThis;
}
if (typeof globalThis.window === "undefined") {
  globalThis.window = globalThis;
}
`).body;

const solverCandidateShape = {
  or: [
    {
      type: "ExpressionStatement",
      expression: {
        type: "AssignmentExpression",
        operator: "=",
        left: {
          or: [{ type: "Identifier" }, { type: "MemberExpression" }],
        },
        right: {
          type: "FunctionExpression",
          async: false,
        },
      },
    },
    {
      type: "FunctionDeclaration",
      async: false,
      id: { type: "Identifier" },
    },
    {
      type: "VariableDeclaration",
      declarations: {
        anykey: [
          {
            type: "VariableDeclarator",
            init: {
              type: "FunctionExpression",
              async: false,
            },
          },
        ],
      },
    },
  ],
};

const urlMutationProbeShape = {
  type: "ExpressionStatement",
  expression: {
    type: "CallExpression",
    callee: {
      type: "MemberExpression",
      object: { type: "Identifier" },
      property: {},
      optional: false,
    },
    arguments: [
      { type: "Literal", value: "alr" },
      { type: "Literal", value: "yes" },
    ],
    optional: false,
  },
};

export class CipherSolver {
  constructor(preprocessedPlayer, metadata = {}) {
    this.preprocessedPlayer = preprocessedPlayer;
    this.metadata = metadata;
    this.solvers = getFromPrepared(preprocessedPlayer);
  }

  solveSignature(signature) {
    if (!signature) {
      return null;
    }
    if (!this.solvers.sig) {
      throw new Error("Failed to extract YouTube signature solver from player JS");
    }
    return this.solvers.sig(signature);
  }

  solveN(n) {
    if (!n) {
      return null;
    }
    if (!this.solvers.n) {
      throw new Error("Failed to extract YouTube n-parameter solver from player JS");
    }
    return this.solvers.n(n);
  }

  solveStream(input, options = {}) {
    return solveGoogleVideoUrl(input, {
      ...options,
      solver: this,
    });
  }

  solveFormat(format, options = {}) {
    return solveStreamFormat(format, {
      ...options,
      solver: this,
    });
  }
}

export async function createCipherSolver(options = {}) {
  const playerJs = options.playerJs ?? await fetchPlayerJs(options.playerUrl, options);
  const cacheKey = options.cacheKey ?? options.playerUrl ?? hashString(playerJs);
  const cached = playerCache.get(cacheKey);

  if (cached?.playerJs === playerJs) {
    return cached.solver;
  }

  const preprocessedPlayer = preprocessPlayer(playerJs);
  const solver = new CipherSolver(preprocessedPlayer, {
    playerUrl: options.playerUrl ?? null,
    cacheKey,
  });

  if (options.cache !== false) {
    playerCache.set(cacheKey, { playerJs, solver });
  }

  return solver;
}

export async function fetchPlayerJs(playerUrl, options = {}) {
  if (!playerUrl) {
    throw new Error("playerUrl or playerJs is required before solving YouTube s/n values");
  }

  const absoluteUrl = absolutizeYoutubeUrl(playerUrl);
  const res = await (options.fetch ?? fetch)(absoluteUrl, {
    headers: {
      "user-agent": options.userAgent ?? "Mozilla/5.0",
      ...(options.headers ?? {}),
    },
  });

  if (!res.ok) {
    throw new Error(`Failed to fetch player JS (${res.status} ${res.statusText}) from ${absoluteUrl}`);
  }

  return await res.text();
}

export async function fetchPlayerUrlFromWatch(videoId, options = {}) {
  return (await fetchPlayerMetadataFromWatch(videoId, options)).playerUrl;
}

let lastFetchedMetadata = null;

export function clearPlayerCache() {
  playerCache.clear();
  lastFetchedMetadata = null;
}

export async function fetchPlayerMetadataFromWatch(videoId, options = {}) {
  if (!videoId) {
    throw new Error("videoId is required to discover player JS from a watch page");
  }

  if (lastFetchedMetadata && !options.forceRefresh) {
    return lastFetchedMetadata;
  }

  const watchUrl = `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`;
  let res;
  let fetchFailed = false;

  try {
    res = await (options.fetch ?? fetch)(watchUrl, {
      headers: {
        "user-agent": options.userAgent ?? "Mozilla/5.0",
        ...(options.headers ?? {}),
      },
    });
    if (!res.ok) {
      fetchFailed = true;
    }
  } catch (err) {
    fetchFailed = true;
  }

  if (fetchFailed) {
    const statusText = res ? `${res.status} ${res.statusText}` : "Network Error";
    console.warn(`[yt-cipher] Watch page fetch failed (${statusText}). Using player metadata fallback.`);
    if (lastFetchedMetadata) {
      return lastFetchedMetadata;
    }
    return {
      playerUrl: "https://www.youtube.com/s/player/66a6ea83/player_ias.vflset/en_GB/base.js",
      visitorData: "CgtUV1hUTUw1X2d2cxIECAEQAA%3D%3D",
      signatureTimestamp: "20640",
    };
  }

  const html = await res.text();
  const match =
    html.match(/"jsUrl":"([^"]+)"/) ??
    html.match(/"js":"([^"]+\/base\.js)"/) ??
    html.match(/src="([^"]+\/s\/player\/[^"]+\/base\.js)"/);

  if (!match) {
    console.warn("[yt-cipher] Failed to find player JS URL in watch page HTML. Using player metadata fallback.");
    if (lastFetchedMetadata) {
      return lastFetchedMetadata;
    }
    return {
      playerUrl: "https://www.youtube.com/s/player/66a6ea83/player_ias.vflset/en_GB/base.js",
      visitorData: "CgtUV1hUTUw1X2d2cxIECAEQAA%3D%3D",
      signatureTimestamp: "20640",
    };
  }

  const visitorDataMatch =
    html.match(/"VISITOR_DATA":"([^"]+)"/) ??
    html.match(/"visitorData":"([^"]+)"/);
  const stsMatch =
    html.match(/"STS":(\d+)/) ??
    html.match(/"signatureTimestamp":(\d+)/) ??
    html.match(/"sts":(\d+)/);

  const metadata = {
    playerUrl: absolutizeYoutubeUrl(match[1].replaceAll("\\/", "/")),
    visitorData: visitorDataMatch?.[1] ? unescapeJsonString(visitorDataMatch[1]) : null,
    signatureTimestamp: stsMatch?.[1] ?? null,
  };

  lastFetchedMetadata = metadata;
  return metadata;
}

export function extractSignatureTimestamp(playerJs) {
  const match = playerJs.match(/(?:signatureTimestamp|sts):(\d+)/);
  if (!match) {
    throw new Error("Failed to extract signatureTimestamp from player JS");
  }
  return match[1];
}

async function tryKikkiaSolve(encryptedSignature, nParam, playerUrl) {
  if (!playerUrl) return null;
  try {
    const res = await fetch("https://cipher.kikkia.dev/decrypt_signature", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        encrypted_signature: encryptedSignature ?? "",
        n_param: nParam ?? "",
        player_url: playerUrl
      }),
      // Simple timeout wrapper
      signal: AbortSignal.timeout(3000)
    });
    if (!res.ok) return null;
    const json = await res.json();
    return {
      decryptedSignature: json.decrypted_signature || null,
      decryptedNParam: json.decrypted_n_sig || json.decrypted_n || null
    };
  } catch (e) {
    return null;
  }
}

export async function solveGoogleVideoUrl(input, options = {}) {
  const solver = options.solver ?? await createCipherSolver(options);
  const parsed = parseStreamInput(input, options);
  const url = new URL(parsed.url);

  const originalN = parsed.n ?? url.searchParams.get("n");
  const originalSignature = parsed.s ?? url.searchParams.get("s");
  const signatureParam = parsed.sp ?? options.signatureParam ?? "signature";

  const playerUrl = options.playerUrl ?? solver.metadata?.playerUrl;
  
  let solvedN = null;
  let solvedSignature = null;

  if (originalSignature || originalN) {
    const kikkiaResult = await tryKikkiaSolve(originalSignature, originalN, playerUrl);
    if (kikkiaResult) {
      solvedN = kikkiaResult.decryptedNParam;
      solvedSignature = kikkiaResult.decryptedSignature;
    }
  }

  // Fallback to local solver if Kikkia returned null or failed
  if (originalN && !solvedN) {
    try {
      solvedN = solver.solveN(originalN);
    } catch (e) {
      console.warn("[yt-cipher] Local N solver failed:", e.message);
    }
  }

  if (originalSignature && !solvedSignature) {
    try {
      solvedSignature = solver.solveSignature(originalSignature);
    } catch (e) {
      console.warn("[yt-cipher] Local Signature solver failed:", e.message);
    }
  }

  if (solvedN) {
    url.searchParams.set("n", solvedN);
  }

  if (solvedSignature) {
    url.searchParams.delete("s");
    url.searchParams.set(signatureParam, solvedSignature);
  }

  return {
    playableUrl: url.toString(),
    url: url.toString(),
    signature: originalSignature
      ? {
          input: originalSignature,
          param: signatureParam,
          value: solvedSignature,
        }
      : null,
    n: originalN
      ? {
          input: originalN,
          value: solvedN,
        }
      : null,
    source: {
      url: parsed.url,
      s: originalSignature ?? null,
      sp: signatureParam,
      n: originalN ?? null,
    },
  };
}

export async function solveStreamFormat(format, options = {}) {
  const source = format.signatureCipher ?? format.cipher ?? format.url;
  if (!source) {
    return {
      ...format,
      cipher: null,
      playableUrl: null,
      cipherError: "Format does not contain url, cipher, or signatureCipher",
    };
  }

  try {
    const solved = await solveGoogleVideoUrl(source, options);
    const playbackHeaders = getPlaybackHeaders(format, options);
    return {
      ...format,
      url: solved.playableUrl,
      playableUrl: solved.playableUrl,
      playbackHeaders,
      cipher: solved,
    };
  } catch (error) {
    return {
      ...format,
      playableUrl: null,
      cipherError: error instanceof Error ? error.message : String(error),
    };
  }
}

export function getPlaybackHeaders(format = {}, options = {}) {
  const range = options.range ?? getChunkRange(options);
  return {
    "accept": "*/*",
    "accept-encoding": "identity",
    ...(options.userAgent ? { "user-agent": options.userAgent } : {}),
    ...(format.playbackHeaders ?? {}),
    "range": range,
    ...(options.playbackHeaders ?? {}),
  };
}

export async function probePlayableUrl(input, options = {}) {
  const url = typeof input === "string" ? input : input?.playableUrl ?? input?.url;
  if (!url) {
    throw new Error("probePlayableUrl requires a URL or solved stream format");
  }

  const headers = getPlaybackHeaders(
    typeof input === "object" ? input : {},
    {
      ...options,
      range: options.range ?? "bytes=0-1",
    },
  );

  const res = await (options.fetch ?? fetch)(url, {
    method: "GET",
    headers,
  });

  res.body?.cancel();

  return {
    ok: res.ok || res.status === 206,
    status: res.status,
    statusText: res.statusText,
    headers: Object.fromEntries(res.headers.entries()),
    requestHeaders: headers,
  };
}

export async function solvePlayerResponse(playerResponse, options = {}) {
  const playerUrl = options.playerUrl ?? await resolvePlayerJsUrl(playerResponse, options);
  const solver = options.solver ?? await createCipherSolver({
    ...options,
    playerUrl,
  });

  const streamingData = playerResponse?.streamingData ?? {};
  const formats = await Promise.all((streamingData.formats ?? []).map((format) =>
    solveStreamFormat(format, { ...options, solver })
  ));
  const adaptiveFormats = await Promise.all((streamingData.adaptiveFormats ?? []).map((format) =>
    solveStreamFormat(format, { ...options, solver })
  ));

  return {
    ...playerResponse,
    streamingData: {
      ...streamingData,
      formats,
      adaptiveFormats,
    },
    cipher: {
      playerUrl,
      hasSignatureSolver: Boolean(solver.solvers.sig),
      hasNSolver: Boolean(solver.solvers.n),
    },
  };
}

export function selectAudioFormats(input, options = {}) {
  const formats = normalizeFormats(input);
  const playableOnly = options.playableOnly ?? true;

  return formats
    .filter((format) => isAudioFormat(format))
    .filter((format) => !playableOnly || Boolean(format.playableUrl ?? format.url))
    .sort(compareAudioFormats);
}

export function selectBestAudioFormat(input, options = {}) {
  return selectAudioFormats(input, options)[0] ?? null;
}

export function selectMuxedFormats(input, options = {}) {
  const formats = normalizeFormats(input);
  const playableOnly = options.playableOnly ?? true;

  return formats
    .filter((format) => isMuxedFormat(format))
    .filter((format) => !playableOnly || Boolean(format.playableUrl ?? format.url))
    .sort(compareMuxedFormats);
}

export function selectBestMuxedFormat(input, options = {}) {
  return selectMuxedFormats(input, options)[0] ?? null;
}

export function isAudioFormat(format) {
  const mimeType = format?.mimeType ?? "";
  if (mimeType.startsWith("audio/")) {
    return true;
  }

  const hasVideoSignals =
    mimeType.startsWith("video/") ||
    format?.width != null ||
    format?.height != null ||
    format?.fps != null ||
    format?.qualityLabel != null;

  return !hasVideoSignals && format?.audioChannels != null;
}

export function isMuxedFormat(format) {
  const mimeType = format?.mimeType ?? "";
  return mimeType.startsWith("video/") && format?.audioChannels != null;
}

export function getFormatCipherInfo(format = {}) {
  const source = format.signatureCipher ?? format.cipher ?? format.url ?? "";
  const params = typeof source === "string" && !source.startsWith("http")
    ? new URLSearchParams(source)
    : null;
  const url = format.url ?? params?.get("url") ?? null;
  const urlParams = url ? new URL(url).searchParams : null;
  const s = format.s ?? params?.get("s") ?? urlParams?.get("s") ?? null;
  const n = format.n ?? params?.get("n") ?? urlParams?.get("n") ?? null;

  return {
    hasDirectUrl: Boolean(format.url),
    hasSignatureCipher: Boolean(format.signatureCipher ?? format.cipher),
    requiresSignatureSolving: Boolean(s),
    requiresNSolving: Boolean(n),
    signatureParam: format.sp ?? params?.get("sp") ?? urlParams?.get("sp") ?? "signature",
  };
}

export function parseStreamInput(input, options = {}) {
  if (typeof input === "string") {
    const trimmed = input.trim();
    if (/^https?:\/\//i.test(trimmed)) {
      const url = new URL(trimmed);
      return {
        url: url.toString(),
        s: options.signature ?? url.searchParams.get("s"),
        sp: options.signatureParam ?? url.searchParams.get("sp") ?? undefined,
        n: options.n ?? url.searchParams.get("n"),
      };
    }

    const params = new URLSearchParams(trimmed);
    const url = params.get("url");
    if (!url) {
      throw new Error("Cipher string must contain a url parameter");
    }
    return {
      url,
      s: options.signature ?? params.get("s"),
      sp: options.signatureParam ?? params.get("sp") ?? undefined,
      n: options.n ?? new URL(url).searchParams.get("n"),
    };
  }

  if (input && typeof input === "object") {
    if (input.signatureCipher || input.cipher) {
      return parseStreamInput(input.signatureCipher ?? input.cipher, options);
    }
    if (!input.url) {
      throw new Error("Stream object must contain url, cipher, or signatureCipher");
    }
    const url = new URL(input.url);
    return {
      url: url.toString(),
      s: options.signature ?? input.s ?? url.searchParams.get("s"),
      sp: options.signatureParam ?? input.sp ?? url.searchParams.get("sp") ?? undefined,
      n: options.n ?? input.n ?? url.searchParams.get("n"),
    };
  }

  throw new Error("Expected a googlevideo URL, signatureCipher string, or stream object");
}

function preprocessPlayer(data) {
  const program = parse(data);
  const plainStatements = modifyPlayer(program);
  const solutions = getSolutions(plainStatements);

  for (const [name, options] of Object.entries(solutions)) {
    plainStatements.push({
      type: "ExpressionStatement",
      expression: {
        type: "AssignmentExpression",
        operator: "=",
        left: {
          type: "MemberExpression",
          computed: false,
          object: { type: "Identifier", name: "_result" },
          property: { type: "Identifier", name },
          optional: false,
        },
        right: multiTry(options),
      },
    });
  }

  program.body.splice(0, 0, ...setupNodes);
  return generate(program);
}

function modifyPlayer(program) {
  const body = program.body;
  let block = null;

  if (body.length === 1) {
    const func = body[0];
    if (
      func?.type === "ExpressionStatement" &&
      func.expression.type === "CallExpression" &&
      func.expression.callee.type === "MemberExpression" &&
      func.expression.callee.object.type === "FunctionExpression"
    ) {
      block = func.expression.callee.object.body;
    }
  } else if (body.length === 2) {
    const func = body[1];
    if (
      func?.type === "ExpressionStatement" &&
      func.expression.type === "CallExpression" &&
      func.expression.callee.type === "FunctionExpression"
    ) {
      block = func.expression.callee.body;
      block.body.splice(0, 1);
    }
  }

  if (!block) {
    throw new Error("Unexpected YouTube player JS wrapper structure");
  }

  block.body = block.body.filter((node) => {
    if (node.type === "ExpressionStatement") {
      if (node.expression.type === "AssignmentExpression") {
        return true;
      }
      return node.expression.type === "Literal";
    }
    return true;
  });

  return block.body;
}

function getSolutions(statements) {
  const found = {
    n: [],
    sig: [],
  };

  for (const statement of statements) {
    const result = extractUrlMutationFunction(statement);
    if (result) {
      found.n.push(makeSolver(result, { type: "Identifier", name: "n" }));
      found.sig.push(makeSolver(result, { type: "Identifier", name: "sig" }));
    }
  }

  return found;
}

function makeSolver(result, ident) {
  return {
    type: "ArrowFunctionExpression",
    params: [ident],
    body: {
      type: "MemberExpression",
      object: {
        type: "CallExpression",
        callee: result,
        arguments: [
          {
            type: "ObjectExpression",
            properties: [
              {
                type: "Property",
                key: ident,
                value: ident,
                kind: "init",
                computed: false,
                method: false,
                shorthand: true,
              },
            ],
          },
        ],
        optional: false,
      },
      computed: false,
      property: ident,
      optional: false,
    },
    async: false,
    expression: true,
    generator: false,
  };
}

function extractUrlMutationFunction(node) {
  if (!matchesStructure(node, solverCandidateShape)) {
    return null;
  }

  const options = [];

  if (node.type === "FunctionDeclaration") {
    if (node.id && node.body?.body) {
      options.push({ name: node.id, statements: node.body.body });
    }
  } else if (node.type === "ExpressionStatement") {
    if (node.expression.type !== "AssignmentExpression") {
      return null;
    }
    const name = node.expression.left;
    const body = node.expression.right?.body?.body;
    if (name && body) {
      options.push({ name, statements: body });
    }
  } else if (node.type === "VariableDeclaration") {
    for (const declaration of node.declarations) {
      const name = declaration.id;
      const body = declaration.init?.body?.body;
      if (name && body) {
        options.push({ name, statements: body });
      }
    }
  }

  for (const { name, statements } of options) {
    if (matchesStructure(statements, { anykey: [urlMutationProbeShape] })) {
      return createSolverProbe(name);
    }
  }

  return null;
}

function createSolverProbe(expression) {
  return generateArrowFunction(`
({ sig, n }) => {
  const url = (${generate(expression)})(
    "https://youtube.com/watch?v=JBA6DzhJxNY",
    "s",
    sig ? encodeURIComponent(sig) : undefined
  );
  url.set("n", n);
  const proto = Object.getPrototypeOf(url);
  const keys = Object.keys(proto).concat(Object.getOwnPropertyNames(proto));
  for (const key of keys) {
    if (!["constructor", "set", "get", "clone"].includes(key)) {
      url[key]();
      break;
    }
  }
  const s = url.get("s");
  return {
    sig: s ? decodeURIComponent(s) : null,
    n: url.get("n") ?? null
  };
}
`);
}

function getFromPrepared(code) {
  const resultObj = { n: null, sig: null };
  Function("_result", code)(resultObj);
  return resultObj;
}

function multiTry(generators) {
  return generateArrowFunction(`
(_input) => {
  const _results = new Set();
  const errors = [];
  for (const _generator of ${generate({
    type: "ArrayExpression",
    elements: generators,
  })}) {
    try {
      _results.add(_generator(_input));
    } catch (e) {
      errors.push(e);
    }
  }
  if (!_results.size) {
    throw \`no solutions: \${errors.join(", ")}\`;
  }
  if (_results.size !== 1) {
    throw \`invalid solutions: \${[..._results].map((x) => JSON.stringify(x)).join(", ")}\`;
  }
  return _results.values().next().value;
}
`);
}

function generateArrowFunction(data) {
  return parse(data).body[0].expression;
}

function matchesStructure(obj, structure) {
  if (Array.isArray(structure)) {
    if (!Array.isArray(obj)) {
      return false;
    }
    return structure.length === obj.length &&
      structure.every((value, index) => matchesStructure(obj[index], value));
  }

  if (structure && typeof structure === "object") {
    if (!obj) {
      return !structure;
    }
    if ("or" in structure) {
      return structure.or.some((node) => matchesStructure(obj, node));
    }
    if ("anykey" in structure && Array.isArray(structure.anykey)) {
      const haystack = Array.isArray(obj) ? obj : Object.values(obj);
      return structure.anykey.every((value) =>
        haystack.some((el) => matchesStructure(el, value))
      );
    }
    for (const [key, value] of Object.entries(structure)) {
      if (!matchesStructure(obj[key], value)) {
        return false;
      }
    }
    return true;
  }

  return structure === obj;
}

async function resolvePlayerJsUrl(playerResponse, options = {}) {
  const fromResponse = extractPlayerJsUrl(playerResponse);
  if (fromResponse) {
    return fromResponse;
  }

  const isTv = options.client === "tv" ||
    options.userAgent?.includes("Cobalt") ||
    playerResponse?.responseContext?.serviceTrackingParams?.some((p) =>
      p.service === "GUIDE" && p.params?.some((x) => x.key === "client.name" && x.value === "TVHTML5")
    );

  if (isTv) {
    try {
      const tvPlayerUrl = await fetchTvPlayerUrl(options);
      if (tvPlayerUrl) {
        return tvPlayerUrl;
      }
    } catch (e) {
      console.warn("Failed to fetch TV player URL, falling back to watch page:", e.message);
    }
  }

  const videoId = options.videoId ?? playerResponse?.videoDetails?.videoId;
  return await fetchPlayerUrlFromWatch(videoId, options);
}

async function fetchTvPlayerUrl(options = {}) {
  const response = await (options.fetch ?? fetch)("https://www.youtube.com/tv", {
    headers: {
      "User-Agent": "Mozilla/5.0 (ChromiumStylePlatform) Cobalt/Version",
      Referer: "https://www.youtube.com/tv",
      "Accept-Language": "en-US",
      ...(options.headers ?? {}),
    },
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch TV page: ${response.status}`);
  }

  const html = await response.text();
  const playerPathMatch = html.match(
    /\/s\/player\/[a-zA-Z0-9_-]{8}\/(?:tv-player-[^"'\\\s]+|player_[^"'\\\s]+)\.js/g,
  );
  if (playerPathMatch?.[0]) {
    return new URL(playerPathMatch[0], YOUTUBE_ORIGIN).toString();
  }

  const baseJsMatch = html.match(
    /<script\s+id="base-js"\s+src="([^"]+)"[^>]*><\/script>/i,
  );
  if (!baseJsMatch?.[1]) {
    throw new Error("Could not find TV player URL");
  }

  return new URL(baseJsMatch[1], YOUTUBE_ORIGIN).toString();
}

function extractPlayerJsUrl(playerResponse) {
  const js = playerResponse?.assets?.js;
  if (!js) {
    return null;
  }
  return absolutizeYoutubeUrl(js);
}

function normalizeFormats(input) {
  if (Array.isArray(input)) {
    return input;
  }

  const streamingData = input?.streamingData ?? input ?? {};
  return [
    ...(streamingData.formats ?? []),
    ...(streamingData.adaptiveFormats ?? []),
  ];
}

function compareAudioFormats(a, b) {
  const aScore = audioFormatScore(a);
  const bScore = audioFormatScore(b);
  return bScore - aScore;
}

function compareMuxedFormats(a, b) {
  const aScore = muxedFormatScore(a);
  const bScore = muxedFormatScore(b);
  return bScore - aScore;
}

function audioFormatScore(format) {
  const mimeType = format?.mimeType ?? "";
  const codecScore =
    mimeType.includes("opus") ? 10_000 :
    mimeType.includes("mp4a") ? 8_000 :
    mimeType.includes("vorbis") ? 7_000 :
    0;
  const defaultScore = format?.audioTrack?.audioIsDefault === false ? -500 : 0;
  return codecScore + Number(format?.bitrate ?? format?.averageBitrate ?? 0) + defaultScore;
}

function muxedFormatScore(format) {
  const mimeType = format?.mimeType ?? "";
  const codecScore = mimeType.includes("avc1") ? 10_000 : 0;
  const heightScore = Number(format?.height ?? 0) * 100;
  const bitrateScore = Number(format?.bitrate ?? format?.averageBitrate ?? 0);
  return codecScore + heightScore + bitrateScore;
}

function getChunkRange(options = {}) {
  const start = Math.max(0, Number(options.start ?? 0));
  const chunkSize = Math.max(1, Number(options.chunkSize ?? 1_048_576));
  const end = options.end == null ? start + chunkSize - 1 : Math.max(start, Number(options.end));
  return `bytes=${start}-${end}`;
}

function absolutizeYoutubeUrl(url) {
  if (/^\/\//.test(url)) {
    return `https:${url}`;
  }
  return new URL(url, YOUTUBE_ORIGIN).toString();
}

function unescapeJsonString(value) {
  try {
    return JSON.parse(`"${value}"`);
  } catch {
    return value.replaceAll("\\/", "/");
  }
}

function hashString(value) {
  let hash = 5381;
  for (let i = 0; i < value.length; i += 1) {
    hash = ((hash << 5) + hash) ^ value.charCodeAt(i);
  }
  return `inline:${hash >>> 0}:${value.length}`;
}
