var __defProp = Object.defineProperty;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });

// src/index.js
import { WorkerEntrypoint } from "cloudflare:workers";
var IG_CONFIG = {
  userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  xIgAppId: "936619743392459"
};
function getShortcode(igUrl) {
  const regex = /instagram\.com\/(?:[A-Za-z0-9_.]+\/)?(p|reels|reel|stories)\/([A-Za-z0-9-_]+)/;
  const match = igUrl.match(regex);
  return match && match[2] ? match[2] : null;
}
__name(getShortcode, "getShortcode");
async function handleDownload(request) {
  const url = new URL(request.url);
  const igUrl = url.searchParams.get("url");
  if (!igUrl) {
    return Response.json({ error: "Missing url parameter" }, { status: 400 });
  }
  const shortcode = getShortcode(igUrl);
  if (!shortcode) {
    return Response.json({ error: "Invalid Instagram URL" }, { status: 400 });
  }
  try {
    const body = new URLSearchParams({
      variables: JSON.stringify({ shortcode }),
      doc_id: "10015901848480474",
      lsd: "AVqbxe3J_YA"
    });
    const response = await fetch("https://www.instagram.com/api/graphql", {
      method: "POST",
      headers: {
        "User-Agent": IG_CONFIG.userAgent,
        "Content-Type": "application/x-www-form-urlencoded",
        "X-IG-App-ID": IG_CONFIG.xIgAppId,
        "X-FB-LSD": "AVqbxe3J_YA",
        "X-ASBD-ID": "129477",
        "Sec-Fetch-Site": "same-origin"
      },
      body: body.toString()
    });
    if (!response.ok) {
      return Response.json({ error: `Instagram returned ${response.status}` }, { status: 502 });
    }
    const json = await response.json();
    const item = json?.data?.xdt_shortcode_media;
    if (!item) {
      return Response.json({ error: "Could not fetch media data" }, { status: 404 });
    }
    return Response.json({
      shortcode: item.shortcode,
      is_video: item.is_video,
      video_url: item.video_url || null,
      thumbnail: item.display_url || item.thumbnail_src,
      caption: item.edge_media_to_caption?.edges?.[0]?.node?.text || "",
      owner: {
        username: item.owner?.username,
        full_name: item.owner?.full_name
      },
      video_duration: item.video_duration,
      view_count: item.video_view_count || item.video_play_count
    });
  } catch (err) {
    return Response.json({ error: "Failed to fetch data" }, { status: 500 });
  }
}
__name(handleDownload, "handleDownload");
async function handleProxyVideo(request) {
  const url = new URL(request.url);
  const videoUrl = url.searchParams.get("url");
  const filename = url.searchParams.get("filename") || "reel";
  if (!videoUrl) {
    return new Response("Missing url parameter", { status: 400 });
  }
  try {
    const response = await fetch(videoUrl, {
      headers: { "User-Agent": IG_CONFIG.userAgent }
    });
    if (!response.ok) {
      return new Response("Failed to fetch video", { status: 502 });
    }
    const safeFilename = filename.replace(/[^\w\s\-]/g, "").replace(/\s+/g, "_").substring(0, 80) || "reel";
    return new Response(response.body, {
      headers: {
        "Content-Type": "video/mp4",
        "Content-Disposition": `attachment; filename="${safeFilename}.mp4"`,
        "Cache-Control": "no-cache"
      }
    });
  } catch (err) {
    return new Response("Proxy error", { status: 500 });
  }
}
__name(handleProxyVideo, "handleProxyVideo");
async function handleTrackDownload(request, env) {
  if (request.method !== "POST") {
    return Response.json({ error: "Method not allowed" }, { status: 405 });
  }
  try {
    const current = parseInt(await env.STATS.get("download_count") || "0", 10);
    await env.STATS.put("download_count", String(current + 1));
    let source = "direct";
    let query = "";
    let reelUrl = "";
    try {
      const body = await request.json();
      source = body.source || "direct";
      query = (body.query || "").trim().toLowerCase().substring(0, 100);
      reelUrl = (body.url || "").trim().substring(0, 300);
    } catch (_) {
    }
    const sourceKey = `download_source:${source}`;
    const sourceCount = parseInt(await env.STATS.get(sourceKey) || "0", 10);
    await env.STATS.put(sourceKey, String(sourceCount + 1));
    const allDownloadsRaw = await env.STATS.get("recent_downloads") || "[]";
    const allDownloads = JSON.parse(allDownloadsRaw);
    allDownloads.unshift({ url: reelUrl, source, query: query || void 0, time: Date.now() });
    if (allDownloads.length > 100) allDownloads.length = 100;
    await env.STATS.put("recent_downloads", JSON.stringify(allDownloads));
    if (source === "search" && query) {
      const queryDownloadKey = `download_from_search:${query}`;
      const queryDownloadCount = parseInt(await env.STATS.get(queryDownloadKey) || "0", 10);
      await env.STATS.put(queryDownloadKey, String(queryDownloadCount + 1));
      const recentRaw = await env.STATS.get("recent_search_downloads") || "[]";
      const recent = JSON.parse(recentRaw);
      recent.unshift({ url: reelUrl, query, time: Date.now() });
      if (recent.length > 50) recent.length = 50;
      await env.STATS.put("recent_search_downloads", JSON.stringify(recent));
    }
    return Response.json({ success: true, count: current + 1 });
  } catch (err) {
    return Response.json({ error: "Failed to track" }, { status: 500 });
  }
}
__name(handleTrackDownload, "handleTrackDownload");
async function handleTikTokDownload(request) {
  const url = new URL(request.url);
  const tiktokUrl = url.searchParams.get("url");
  if (!tiktokUrl) {
    return Response.json({ error: "Missing url parameter" }, { status: 400 });
  }
  try {
    const response = await fetch("https://tikwm.com/api/?url=" + encodeURIComponent(tiktokUrl), {
      headers: {
        "User-Agent": IG_CONFIG.userAgent,
        "Accept": "application/json"
      }
    });
    if (!response.ok) {
      return Response.json({ error: `TikTok API returned ${response.status}` }, { status: 502 });
    }
    const json = await response.json();
    if (json.code !== 0 || !json.data) {
      return Response.json({ error: json.msg || "Could not fetch TikTok data" }, { status: 404 });
    }
    const item = json.data;
    return Response.json({
      id: item.id,
      is_video: true,
      video_url: item.play || null,
      thumbnail: item.cover,
      caption: item.title || "",
      owner: {
        username: item.author?.unique_id,
        full_name: item.author?.nickname
      },
      video_duration: item.duration,
      view_count: item.play_count
    });
  } catch (err) {
    return Response.json({ error: "Failed to fetch TikTok data" }, { status: 500 });
  }
}
__name(handleTikTokDownload, "handleTikTokDownload");
async function handleTrackSearch(request, env) {
  if (request.method !== "POST") {
    return Response.json({ error: "Method not allowed" }, { status: 405 });
  }
  try {
    const body = await request.json();
    const query = (body.query || "").trim().toLowerCase().substring(0, 100);
    if (!query) {
      return Response.json({ error: "Missing query" }, { status: 400 });
    }
    const totalSearches = parseInt(await env.STATS.get("search_count") || "0", 10);
    await env.STATS.put("search_count", String(totalSearches + 1));
    const termKey = `search_term:${query}`;
    const termCount = parseInt(await env.STATS.get(termKey) || "0", 10);
    await env.STATS.put(termKey, String(termCount + 1));
    const recentRaw = await env.STATS.get("recent_searches") || "[]";
    const recent = JSON.parse(recentRaw);
    recent.unshift({ query, time: Date.now() });
    if (recent.length > 50) recent.length = 50;
    await env.STATS.put("recent_searches", JSON.stringify(recent));
    return Response.json({ success: true });
  } catch (err) {
    return Response.json({ error: "Failed to track search" }, { status: 500 });
  }
}
__name(handleTrackSearch, "handleTrackSearch");
async function handleStats(request, env) {
  const url = new URL(request.url);
  const key = url.searchParams.get("key");
  if (key !== env.STATS_SECRET) {
    return Response.json({ error: "Unauthorized" }, { status: 403 });
  }
  try {
    const downloadCount = parseInt(await env.STATS.get("download_count") || "0", 10);
    const searchCount = parseInt(await env.STATS.get("search_count") || "0", 10);
    const downloadDirect = parseInt(await env.STATS.get("download_source:direct") || "0", 10);
    const downloadFromSearch = parseInt(await env.STATS.get("download_source:search") || "0", 10);
    const recentSearchesRaw = await env.STATS.get("recent_searches") || "[]";
    const recentSearches = JSON.parse(recentSearchesRaw);
    const recentDownloadsRaw = await env.STATS.get("recent_downloads") || "[]";
    const recentDownloads = JSON.parse(recentDownloadsRaw);
    const recentSearchDownloadsRaw = await env.STATS.get("recent_search_downloads") || "[]";
    const recentSearchDownloads = JSON.parse(recentSearchDownloadsRaw);
    return Response.json({
      download_count: downloadCount,
      download_direct: downloadDirect,
      download_from_search: downloadFromSearch,
      search_count: searchCount,
      recent_searches: recentSearches,
      recent_downloads: recentDownloads,
      recent_search_downloads: recentSearchDownloads
    });
  } catch (err) {
    return Response.json({ error: "Failed to get stats" }, { status: 500 });
  }
}
__name(handleStats, "handleStats");
var seoTranslations = {
  en: {
    title: "SaveMyReels - Free Reels & TikTok Finder | Search & Download",
    description: "Search and download Instagram Reels and TikToks for free. Find trending videos by keyword, download videos as MP4 \u2014 no watermark, no login required.",
    ogTitle: "SaveMyReels - Search & Download Instagram & TikTok Free",
    ogDescription: "Search and download Instagram Reels and TikToks for free. Find trending videos by keyword, download in MP4. No watermark, no login required."
  },
  tr: {
    title: "SaveMyReels - \xDCcretsiz Reels & TikTok Bulucu | Ara & \u0130ndir",
    description: "Instagram Reels ve TikTok videolar\u0131n\u0131 \xFCcretsiz aray\u0131n ve indirin. Anahtar kelimeyle trend videolar bulun, MP4 olarak kaydedin \u2014 filigran yok, giri\u015F gerekmez.",
    ogTitle: "SaveMyReels - Instagram & TikTok Ara & \u0130ndir \xDCcretsiz",
    ogDescription: "Instagram Reels ve TikTok videolar\u0131n\u0131 \xFCcretsiz aray\u0131n ve indirin. Trend videolar bulun, MP4 olarak kaydedin. Filigran yok, giri\u015F gerekmez."
  },
  de: {
    title: "SaveMyReels - Kostenloser Reels & TikTok Finder | Suchen & Herunterladen",
    description: "Instagram Reels und TikToks kostenlos suchen und herunterladen. Videos nach Stichwort finden, als MP4 speichern \u2014 kein Wasserzeichen, kein Login.",
    ogTitle: "SaveMyReels - Instagram & TikTok Suchen & Herunterladen Kostenlos",
    ogDescription: "Instagram Reels und TikToks kostenlos suchen und herunterladen. Videos nach Stichwort finden, als MP4 speichern. Kein Wasserzeichen, kein Login."
  },
  es: {
    title: "SaveMyReels - Buscador de Reels y TikTok Gratis | Buscar y Descargar",
    description: "Busca y descarga Instagram Reels y TikToks gratis. Encuentra videos en tendencia, descarga como MP4 \u2014 sin marca de agua, sin login.",
    ogTitle: "SaveMyReels - Buscar y Descargar Instagram y TikTok Gratis",
    ogDescription: "Busca y descarga Instagram Reels y TikToks gratis. Encuentra videos en tendencia, descarga como MP4. Sin marca de agua, sin login."
  },
  fr: {
    title: "SaveMyReels - Chercheur de Reels et TikTok Gratuit | Rechercher et T\xE9l\xE9charger",
    description: "Recherchez et t\xE9l\xE9chargez des Instagram Reels et TikToks gratuitement. Trouvez des vid\xE9os tendance, t\xE9l\xE9chargez en MP4 \u2014 sans filigrane, sans connexion.",
    ogTitle: "SaveMyReels - Rechercher et T\xE9l\xE9charger Instagram et TikTok Gratuit",
    ogDescription: "Recherchez et t\xE9l\xE9chargez des Instagram Reels et TikToks gratuitement. Trouvez des vid\xE9os tendance, t\xE9l\xE9chargez en MP4. Sans filigrane, sans connexion."
  },
  pt: {
    title: "SaveMyReels - Buscador de Reels e TikTok Gr\xE1tis | Pesquisar e Baixar",
    description: "Pesquise e baixe Instagram Reels e TikToks gratuitamente. Encontre v\xEDdeos em alta, baixe como MP4 \u2014 sem marca d'\xE1gua, sem login.",
    ogTitle: "SaveMyReels - Pesquisar e Baixar Instagram e TikTok Gr\xE1tis",
    ogDescription: "Pesquise e baixe Instagram Reels e TikToks gratuitamente. Encontre v\xEDdeos em alta, baixe como MP4. Sem marca d'\xE1gua, sem login."
  },
  ar: {
    title: "SaveMyReels - \u0645\u062D\u0631\u0643 \u0628\u062D\u062B Reels \u0648 TikTok \u0645\u062C\u0627\u0646\u064A | \u0627\u0628\u062D\u062B \u0648\u062D\u0645\u0651\u0644",
    description: "\u0627\u0628\u062D\u062B \u0648\u062D\u0645\u0651\u0644 Instagram Reels \u0648 TikToks \u0645\u062C\u0627\u0646\u0627\u064B. \u0627\u0628\u062D\u062B \u0639\u0646 \u0627\u0644\u0641\u064A\u062F\u064A\u0648\u0647\u0627\u062A \u0627\u0644\u0631\u0627\u0626\u062C\u0629\u060C \u062D\u0645\u0651\u0644 \u0628\u0635\u064A\u063A\u0629 MP4 \u2014 \u0628\u062F\u0648\u0646 \u0639\u0644\u0627\u0645\u0629 \u0645\u0627\u0626\u064A\u0629\u060C \u0628\u062F\u0648\u0646 \u062A\u0633\u062C\u064A\u0644 \u062F\u062E\u0648\u0644.",
    ogTitle: "SaveMyReels - \u0627\u0628\u062D\u062B \u0648\u062D\u0645\u0651\u0644 Instagram \u0648 TikTok \u0645\u062C\u0627\u0646\u0627\u064B",
    ogDescription: "\u0627\u0628\u062D\u062B \u0648\u062D\u0645\u0651\u0644 Instagram Reels \u0648 TikToks \u0645\u062C\u0627\u0646\u0627\u064B. \u0627\u0628\u062D\u062B \u0639\u0646 \u0627\u0644\u0641\u064A\u062F\u064A\u0648\u0647\u0627\u062A \u0627\u0644\u0631\u0627\u0626\u062C\u0629\u060C \u062D\u0645\u0651\u0644 \u0628\u0635\u064A\u063A\u0629 MP4. \u0628\u062F\u0648\u0646 \u0639\u0644\u0627\u0645\u0629 \u0645\u0627\u0626\u064A\u0629\u060C \u0628\u062F\u0648\u0646 \u062A\u0633\u062C\u064A\u0644 \u062F\u062E\u0648\u0644."
  }
};
function detectLanguage(request) {
  const acceptLanguage = request.headers.get("Accept-Language") || "en";
  const primaryLang = acceptLanguage.split(",")[0].split("-")[0].toLowerCase();
  const supportedLangs = ["en", "tr", "de", "es", "fr", "pt", "ar"];
  return supportedLangs.includes(primaryLang) ? primaryLang : "en";
}
__name(detectLanguage, "detectLanguage");
var src_default = class extends WorkerEntrypoint {
  static {
    __name(this, "default");
  }
  async fetch(request) {
    const env = this.env;
    const url = new URL(request.url);
    if (url.pathname === "/api/download") {
      return handleDownload(request);
    }
    if (url.pathname === "/api/download-tiktok") {
      return handleTikTokDownload(request);
    }
    if (url.pathname === "/api/proxy-video") {
      return handleProxyVideo(request);
    }
    if (url.pathname === "/api/track-download") {
      return handleTrackDownload(request, env);
    }
    if (url.pathname === "/api/track-search") {
      return handleTrackSearch(request, env);
    }
    if (url.pathname === "/api/stats") {
      return handleStats(request, env);
    }
    const response = await env.ASSETS.fetch(request);
    const contentType = response.headers.get("Content-Type") || "";
    if (!contentType.includes("text/html")) {
      return response;
    }
    const lang = detectLanguage(request);
    const seo = seoTranslations[lang] || seoTranslations.en;
    return new HTMLRewriter().on("title", {
      element(element) {
        element.setInnerContent(seo.title);
      }
    }).on('meta[name="description"]', {
      element(element) {
        element.setAttribute("content", seo.description);
      }
    }).on('meta[property="og:title"]', {
      element(element) {
        element.setAttribute("content", seo.ogTitle);
      }
    }).on('meta[property="og:description"]', {
      element(element) {
        element.setAttribute("content", seo.ogDescription);
      }
    }).on('meta[name="twitter:title"]', {
      element(element) {
        element.setAttribute("content", seo.ogTitle);
      }
    }).on('meta[name="twitter:description"]', {
      element(element) {
        element.setAttribute("content", seo.ogDescription);
      }
    }).on("html", {
      element(element) {
        element.setAttribute("lang", lang);
      }
    }).transform(response);
  }
};

// ../.npm/_npx/32026684e21afda6/node_modules/wrangler/templates/middleware/middleware-ensure-req-body-drained.ts
var drainBody = /* @__PURE__ */ __name(async (request, env, _ctx, middlewareCtx) => {
  try {
    return await middlewareCtx.next(request, env);
  } finally {
    try {
      if (request.body !== null && !request.bodyUsed) {
        const reader = request.body.getReader();
        while (!(await reader.read()).done) {
        }
      }
    } catch (e) {
      console.error("Failed to drain the unused request body.", e);
    }
  }
}, "drainBody");
var middleware_ensure_req_body_drained_default = drainBody;

// ../.npm/_npx/32026684e21afda6/node_modules/wrangler/templates/middleware/middleware-miniflare3-json-error.ts
function reduceError(e) {
  return {
    name: e?.name,
    message: e?.message ?? String(e),
    stack: e?.stack,
    cause: e?.cause === void 0 ? void 0 : reduceError(e.cause)
  };
}
__name(reduceError, "reduceError");
var jsonError = /* @__PURE__ */ __name(async (request, env, _ctx, middlewareCtx) => {
  try {
    return await middlewareCtx.next(request, env);
  } catch (e) {
    const error = reduceError(e);
    return Response.json(error, {
      status: 500,
      headers: { "MF-Experimental-Error-Stack": "true" }
    });
  }
}, "jsonError");
var middleware_miniflare3_json_error_default = jsonError;

// .wrangler/tmp/bundle-zntT9Y/middleware-insertion-facade.js
var __INTERNAL_WRANGLER_MIDDLEWARE__ = [
  middleware_ensure_req_body_drained_default,
  middleware_miniflare3_json_error_default
];
var middleware_insertion_facade_default = src_default;

// ../.npm/_npx/32026684e21afda6/node_modules/wrangler/templates/middleware/common.ts
var __facade_middleware__ = [];
function __facade_register__(...args) {
  __facade_middleware__.push(...args.flat());
}
__name(__facade_register__, "__facade_register__");
function __facade_invokeChain__(request, env, ctx, dispatch, middlewareChain) {
  const [head, ...tail] = middlewareChain;
  const middlewareCtx = {
    dispatch,
    next(newRequest, newEnv) {
      return __facade_invokeChain__(newRequest, newEnv, ctx, dispatch, tail);
    }
  };
  return head(request, env, ctx, middlewareCtx);
}
__name(__facade_invokeChain__, "__facade_invokeChain__");
function __facade_invoke__(request, env, ctx, dispatch, finalMiddleware) {
  return __facade_invokeChain__(request, env, ctx, dispatch, [
    ...__facade_middleware__,
    finalMiddleware
  ]);
}
__name(__facade_invoke__, "__facade_invoke__");

// .wrangler/tmp/bundle-zntT9Y/middleware-loader.entry.ts
var __Facade_ScheduledController__ = class ___Facade_ScheduledController__ {
  constructor(scheduledTime, cron, noRetry) {
    this.scheduledTime = scheduledTime;
    this.cron = cron;
    this.#noRetry = noRetry;
  }
  static {
    __name(this, "__Facade_ScheduledController__");
  }
  #noRetry;
  noRetry() {
    if (!(this instanceof ___Facade_ScheduledController__)) {
      throw new TypeError("Illegal invocation");
    }
    this.#noRetry();
  }
};
function wrapExportedHandler(worker) {
  if (__INTERNAL_WRANGLER_MIDDLEWARE__ === void 0 || __INTERNAL_WRANGLER_MIDDLEWARE__.length === 0) {
    return worker;
  }
  for (const middleware of __INTERNAL_WRANGLER_MIDDLEWARE__) {
    __facade_register__(middleware);
  }
  const fetchDispatcher = /* @__PURE__ */ __name(function(request, env, ctx) {
    if (worker.fetch === void 0) {
      throw new Error("Handler does not export a fetch() function.");
    }
    return worker.fetch(request, env, ctx);
  }, "fetchDispatcher");
  return {
    ...worker,
    fetch(request, env, ctx) {
      const dispatcher = /* @__PURE__ */ __name(function(type, init) {
        if (type === "scheduled" && worker.scheduled !== void 0) {
          const controller = new __Facade_ScheduledController__(
            Date.now(),
            init.cron ?? "",
            () => {
            }
          );
          return worker.scheduled(controller, env, ctx);
        }
      }, "dispatcher");
      return __facade_invoke__(request, env, ctx, dispatcher, fetchDispatcher);
    }
  };
}
__name(wrapExportedHandler, "wrapExportedHandler");
function wrapWorkerEntrypoint(klass) {
  if (__INTERNAL_WRANGLER_MIDDLEWARE__ === void 0 || __INTERNAL_WRANGLER_MIDDLEWARE__.length === 0) {
    return klass;
  }
  for (const middleware of __INTERNAL_WRANGLER_MIDDLEWARE__) {
    __facade_register__(middleware);
  }
  return class extends klass {
    #fetchDispatcher = /* @__PURE__ */ __name((request, env, ctx) => {
      this.env = env;
      this.ctx = ctx;
      if (super.fetch === void 0) {
        throw new Error("Entrypoint class does not define a fetch() function.");
      }
      return super.fetch(request);
    }, "#fetchDispatcher");
    #dispatcher = /* @__PURE__ */ __name((type, init) => {
      if (type === "scheduled" && super.scheduled !== void 0) {
        const controller = new __Facade_ScheduledController__(
          Date.now(),
          init.cron ?? "",
          () => {
          }
        );
        return super.scheduled(controller);
      }
    }, "#dispatcher");
    fetch(request) {
      return __facade_invoke__(
        request,
        this.env,
        this.ctx,
        this.#dispatcher,
        this.#fetchDispatcher
      );
    }
  };
}
__name(wrapWorkerEntrypoint, "wrapWorkerEntrypoint");
var WRAPPED_ENTRY;
if (typeof middleware_insertion_facade_default === "object") {
  WRAPPED_ENTRY = wrapExportedHandler(middleware_insertion_facade_default);
} else if (typeof middleware_insertion_facade_default === "function") {
  WRAPPED_ENTRY = wrapWorkerEntrypoint(middleware_insertion_facade_default);
}
var middleware_loader_entry_default = WRAPPED_ENTRY;
export {
  __INTERNAL_WRANGLER_MIDDLEWARE__,
  middleware_loader_entry_default as default
};
//# sourceMappingURL=index.js.map
