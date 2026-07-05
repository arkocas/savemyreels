import { WorkerEntrypoint } from 'cloudflare:workers';

const IG_CONFIG = {
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    mobileUserAgent: 'Instagram 317.0.0.34.109 Android (31/12; 420dpi; 1080x2340; samsung; SM-G991B; o1s; exynos2100; en_US; 561671766)',
    xIgAppId: '936619743392459',
    // Multiple doc_ids to try — Instagram rotates these every 2-4 weeks
    docIds: [
        '8845758582119845',
        '10015901848480474',
        '9510064795764498'
    ]
};

// Encoding table for shortcode <-> pk conversion (same as yt-dlp)
const ENCODING_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

function shortcodeToPk(shortcode) {
    let pk = BigInt(0);
    for (const ch of shortcode) {
        pk = pk * BigInt(64) + BigInt(ENCODING_CHARS.indexOf(ch));
    }
    return pk.toString();
}

function getShortcode(igUrl) {
    const regex = /instagram\.com\/(?:[A-Za-z0-9_.]+\/)?(p|reels|reel|stories)\/([A-Za-z0-9-_]+)/;
    const match = igUrl.match(regex);
    return match && match[2] ? match[2] : null;
}

// Normalize response from different API formats into a unified shape
function normalizeResponse(data, shortcode) {
    // Format 1: GraphQL web response (xdt_shortcode_media)
    if (data?.data?.xdt_shortcode_media) {
        const item = data.data.xdt_shortcode_media;
        return {
            shortcode: item.shortcode || shortcode,
            is_video: item.is_video,
            video_url: item.video_url || null,
            thumbnail: item.display_url || item.thumbnail_src,
            caption: item.edge_media_to_caption?.edges?.[0]?.node?.text || '',
            owner: {
                username: item.owner?.username,
                full_name: item.owner?.full_name,
            },
            video_duration: item.video_duration,
            view_count: item.video_view_count || item.video_play_count,
        };
    }

    // Format 2: Mobile API response (items array)
    if (data?.items?.[0]) {
        const item = data.items[0];
        const videoVersions = item.video_versions;
        const videoUrl = videoVersions?.[0]?.url || null;
        const caption = item.caption?.text || '';
        return {
            shortcode: shortcode,
            is_video: item.media_type === 2 || !!videoUrl,
            video_url: videoUrl,
            thumbnail: item.image_versions2?.candidates?.[0]?.url || '',
            caption: caption,
            owner: {
                username: item.user?.username,
                full_name: item.user?.full_name,
            },
            video_duration: item.video_duration,
            view_count: item.view_count || item.play_count,
        };
    }

    // Format 3: GraphQL xdt_api response
    if (data?.data?.xdt_api__v1__media__shortcode__web_info?.items?.[0]) {
        const item = data.data.xdt_api__v1__media__shortcode__web_info.items[0];
        const videoVersions = item.video_versions;
        const videoUrl = videoVersions?.[0]?.url || null;
        return {
            shortcode: shortcode,
            is_video: item.media_type === 2 || !!videoUrl,
            video_url: videoUrl,
            thumbnail: item.image_versions2?.candidates?.[0]?.url || '',
            caption: item.caption?.text || '',
            owner: {
                username: item.user?.username,
                full_name: item.user?.full_name,
            },
            video_duration: item.video_duration,
            view_count: item.view_count || item.play_count,
        };
    }

    return null;
}

// Method 1: Mobile API (most stable — used by yt-dlp)
async function tryMobileApi(shortcode) {
    const pk = shortcodeToPk(shortcode);
    const response = await fetch(`https://i.instagram.com/api/v1/media/${pk}/info/`, {
        headers: {
            'User-Agent': IG_CONFIG.mobileUserAgent,
            'X-IG-App-ID': IG_CONFIG.xIgAppId,
            'Accept': '*/*',
            'Accept-Language': 'en-US,en;q=0.9',
            'X-ASBD-ID': '359341',
            'X-IG-WWW-Claim': '0',
            'Origin': 'https://www.instagram.com',
        }
    });
    if (!response.ok) return null;
    return await response.json();
}

// Method 2: Web GraphQL API (tries multiple doc_ids)
async function tryGraphqlApi(shortcode) {
    for (const docId of IG_CONFIG.docIds) {
        try {
            const body = new URLSearchParams({
                variables: JSON.stringify({ shortcode }),
                doc_id: docId,
                lsd: 'AVqbxe3J_YA'
            });

            const response = await fetch('https://www.instagram.com/api/graphql', {
                method: 'POST',
                headers: {
                    'User-Agent': IG_CONFIG.userAgent,
                    'Content-Type': 'application/x-www-form-urlencoded',
                    'X-IG-App-ID': IG_CONFIG.xIgAppId,
                    'X-FB-LSD': 'AVqbxe3J_YA',
                    'X-ASBD-ID': '359341',
                    'Sec-Fetch-Site': 'same-origin',
                    'Origin': 'https://www.instagram.com',
                    'Referer': 'https://www.instagram.com/',
                },
                body: body.toString()
            });

            if (!response.ok) continue;
            const json = await response.json();
            if (json?.data?.xdt_shortcode_media || json?.data?.xdt_api__v1__media__shortcode__web_info) {
                return json;
            }
        } catch (_) {
            // Try next doc_id
        }
    }
    return null;
}

// Method 3: Scrape the web page for embedded JSON data
async function tryPageScrape(shortcode) {
    try {
        const response = await fetch(`https://www.instagram.com/p/${shortcode}/`, {
            headers: {
                'User-Agent': IG_CONFIG.userAgent,
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                'Accept-Language': 'en-US,en;q=0.9',
                'Sec-Fetch-Mode': 'navigate',
                'Sec-Fetch-Site': 'none',
            }
        });
        if (!response.ok) return null;
        const html = await response.text();

        // Try to extract video_url from embedded JSON in the page
        const videoUrlMatch = html.match(/"video_url"\s*:\s*"(https?:[^"]+)"/);
        if (videoUrlMatch) {
            const videoUrl = videoUrlMatch[1].replace(/\\u0026/g, '&').replace(/\\\//g, '/');
            // Try to extract more data
            const captionMatch = html.match(/"text"\s*:\s*"([^"]{0,500})"/);
            const usernameMatch = html.match(/"username"\s*:\s*"([^"]+)"/);
            return {
                items: [{
                    video_versions: [{ url: videoUrl }],
                    media_type: 2,
                    caption: captionMatch ? { text: captionMatch[1] } : null,
                    user: usernameMatch ? { username: usernameMatch[1] } : null,
                }]
            };
        }
    } catch (_) {}
    return null;
}

async function handleDownload(request) {
    const url = new URL(request.url);
    const igUrl = url.searchParams.get('url');

    if (!igUrl) {
        return Response.json({ error: 'Missing url parameter' }, { status: 400 });
    }

    const shortcode = getShortcode(igUrl);
    if (!shortcode) {
        return Response.json({ error: 'Invalid Instagram URL' }, { status: 400 });
    }

    // Try multiple methods with fallback
    const methods = [
        { name: 'mobile_api', fn: () => tryMobileApi(shortcode) },
        { name: 'graphql_api', fn: () => tryGraphqlApi(shortcode) },
        { name: 'page_scrape', fn: () => tryPageScrape(shortcode) },
    ];

    for (const method of methods) {
        try {
            const rawData = await method.fn();
            if (!rawData) continue;

            const result = normalizeResponse(rawData, shortcode);
            if (result && result.video_url) {
                return Response.json(result);
            }
        } catch (_) {
            // Try next method
        }
    }

    return Response.json({ error: 'Could not fetch video. Instagram may have blocked the request.' }, { status: 502 });
}

async function handleProxyVideo(request) {
    const url = new URL(request.url);
    const videoUrl = url.searchParams.get('url');
    const filename = url.searchParams.get('filename') || 'reel';

    if (!videoUrl) {
        return new Response('Missing url parameter', { status: 400 });
    }

    try {
        const response = await fetch(videoUrl, {
            headers: {
                'User-Agent': IG_CONFIG.userAgent,
                'Referer': 'https://www.instagram.com/',
                'Accept': '*/*',
            }
        });

        if (!response.ok) {
            return new Response('Failed to fetch video', { status: 502 });
        }

        const safeFilename = filename
            .replace(/[^\w\s\-]/g, '')
            .replace(/\s+/g, '_')
            .substring(0, 80) || 'reel';

        return new Response(response.body, {
            headers: {
                'Content-Type': 'video/mp4',
                'Content-Disposition': `attachment; filename="${safeFilename}.mp4"`,
                'Cache-Control': 'no-cache',
                'Access-Control-Allow-Origin': '*',
            }
        });
    } catch (err) {
        return new Response('Proxy error', { status: 500 });
    }
}

async function getGlobalStats(env) {
    let stats = {
        download_count: 0,
        search_count: 0,
        downloads_by_source: { direct: 0, search: 0 },
        downloads_by_platform: { instagram: 0 },
        searches_by_platform: { instagram: 0 },
        recent_searches: [],
        recent_downloads: [],
        recent_search_downloads: []
    };
    try {
        const raw = await env.STATS.get('global_stats');
        if (raw) {
            const parsed = JSON.parse(raw);
            stats = { ...stats, ...parsed };
        }
    } catch (_) {}
    return stats;
}

async function handleTrackDownload(request, env) {
    if (request.method !== 'POST') {
        return Response.json({ error: 'Method not allowed' }, { status: 405 });
    }

    try {
        let source = 'direct';
        let query = '';
        let reelUrl = '';
        let platform = 'instagram';
        try {
            const body = await request.json();
            source = body.source || 'direct';
            query = (body.query || '').trim().toLowerCase().substring(0, 100);
            platform = (body.platform || 'instagram').toLowerCase();
            reelUrl = (body.url || '').trim().substring(0, 300);
        } catch (_) {}

        const stats = await getGlobalStats(env);
        stats.download_count++;
        stats.downloads_by_source[source] = (stats.downloads_by_source[source] || 0) + 1;
        stats.downloads_by_platform[platform] = (stats.downloads_by_platform[platform] || 0) + 1;

        stats.recent_downloads.unshift({ url: reelUrl, source, platform, query: query || undefined, time: Date.now() });
        if (stats.recent_downloads.length > 50) stats.recent_downloads.length = 50; // Sınırı 50'ye düşürdük

        if (source === 'search' && query) {
            stats.recent_search_downloads.unshift({ url: reelUrl, query, platform, time: Date.now() });
            if (stats.recent_search_downloads.length > 30) stats.recent_search_downloads.length = 30;
        }

        await env.STATS.put('global_stats', JSON.stringify(stats));
        return Response.json({ success: true, count: stats.download_count });
    } catch (err) {
        return Response.json({ error: 'Failed to track' }, { status: 500 });
    }
}



async function handleTrackSearch(request, env) {
    if (request.method !== 'POST') {
        return Response.json({ error: 'Method not allowed' }, { status: 405 });
    }

    try {
        const body = await request.json();
        const query = (body.query || '').trim().toLowerCase().substring(0, 100);
        const platform = (body.platform || 'instagram').toLowerCase();

        if (!query) {
            return Response.json({ error: 'Missing query' }, { status: 400 });
        }

        const stats = await getGlobalStats(env);
        stats.search_count++;
        stats.searches_by_platform[platform] = (stats.searches_by_platform[platform] || 0) + 1;

        stats.recent_searches.unshift({ query, platform, time: Date.now() });
        if (stats.recent_searches.length > 30) stats.recent_searches.length = 30; // Sınırı 30'a düşürdük

        await env.STATS.put('global_stats', JSON.stringify(stats));
        return Response.json({ success: true });
    } catch (err) {
        return Response.json({ error: 'Failed to track search' }, { status: 500 });
    }
}

async function handleStats(request, env) {
    const url = new URL(request.url);
    const key = url.searchParams.get('key');

    if (key !== env.STATS_SECRET) {
        return Response.json({ error: 'Unauthorized' }, { status: 403 });
    }

    try {
        const stats = await getGlobalStats(env);

        return Response.json({
            download_count: stats.download_count,
            download_direct: stats.downloads_by_source.direct || 0,
            download_from_search: stats.downloads_by_source.search || 0,
            search_count: stats.search_count,

            instagram_search_count: stats.searches_by_platform.instagram || 0,
            instagram_download_count: stats.downloads_by_platform.instagram || 0,

            recent_searches: stats.recent_searches,
            recent_downloads: stats.recent_downloads,
            recent_search_downloads: stats.recent_search_downloads
        });
    } catch (err) {
        return Response.json({ error: 'Failed to get stats' }, { status: 500 });
    }
}

// SEO meta translations — focused on Instagram Reels Finder (primary identity)
const seoTranslations = {
    en: {
        title: 'SaveMyReels - Best Free Instagram Reels Finder | Search & Download Reels',
        description: 'SaveMyReels is the #1 free Instagram Reels Finder. Search and find trending Instagram Reels by keyword, download any Reel as HD MP4 — no watermark, no login required.',
        ogTitle: 'SaveMyReels - Instagram Reels Finder & Downloader | Free',
        ogDescription: 'The best free Instagram Reels Finder. Search trending Reels by keyword, download as HD MP4 without watermarks. No login required.'
    },
    tr: {
        title: 'SaveMyReels - En İyi Ücretsiz Instagram Reels Bulucu | Reels Ara ve İndir',
        description: 'SaveMyReels, 1 numaralı ücretsiz Instagram Reels Bulucu (Reels Finder) aracıdır. Trend Reels videolarını anahtar kelimeyle bulun, filigransız HD MP4 olarak indirin.',
        ogTitle: 'SaveMyReels - Instagram Reels Bulucu ve İndirici | Ücretsiz',
        ogDescription: 'En iyi ücretsiz Instagram Reels Bulucu. Trend Reels arayın, filigransız HD MP4 olarak indirin. Giriş gerekmez.'
    },
    de: {
        title: 'SaveMyReels - Bester kostenloser Instagram Reels Finder | Reels suchen & herunterladen',
        description: 'SaveMyReels ist der beste kostenlose Instagram Reels Finder. Finden Sie Trend-Reels per Stichwort, laden Sie als HD MP4 herunter — kein Wasserzeichen, kein Login.',
        ogTitle: 'SaveMyReels - Instagram Reels Finder & Downloader | Kostenlos',
        ogDescription: 'Der beste kostenlose Instagram Reels Finder. Trend-Reels suchen, als HD MP4 ohne Wasserzeichen herunterladen. Kein Login nötig.'
    },
    es: {
        title: 'SaveMyReels - Mejor Buscador de Instagram Reels Gratis | Buscar y Descargar Reels',
        description: 'SaveMyReels es el mejor buscador de Instagram Reels gratis. Encuentra Reels en tendencia por palabra clave, descarga como MP4 HD — sin marca de agua, sin login.',
        ogTitle: 'SaveMyReels - Buscador de Instagram Reels y Descargador | Gratis',
        ogDescription: 'El mejor buscador de Instagram Reels gratis. Busca Reels en tendencia, descarga como MP4 HD sin marca de agua. Sin login.'
    },
    fr: {
        title: 'SaveMyReels - Meilleur chercheur d\'Instagram Reels gratuit | Rechercher et télécharger',
        description: 'SaveMyReels est le meilleur outil gratuit pour trouver des Instagram Reels. Trouvez des Reels tendance par mot-clé, téléchargez en MP4 HD — sans filigrane, sans connexion.',
        ogTitle: 'SaveMyReels - Instagram Reels Finder & Téléchargeur | Gratuit',
        ogDescription: 'Le meilleur outil gratuit pour trouver des Instagram Reels. Recherchez des Reels tendance, téléchargez en MP4 HD sans filigrane.'
    },
    pt: {
        title: 'SaveMyReels - Melhor Buscador de Instagram Reels Grátis | Pesquisar e Baixar Reels',
        description: 'SaveMyReels é o melhor buscador de Instagram Reels grátis. Encontre Reels em alta por palavra-chave, baixe como MP4 HD — sem marca d\'água, sem login.',
        ogTitle: 'SaveMyReels - Buscador de Instagram Reels e Baixador | Grátis',
        ogDescription: 'O melhor buscador de Instagram Reels grátis. Pesquise Reels em alta, baixe como MP4 HD sem marca d\'água. Sem login.'
    },
    ar: {
        title: 'SaveMyReels - أفضل باحث Instagram Reels مجاني | ابحث وحمّل Reels',
        description: 'SaveMyReels هو أفضل أداة مجانية للعثور على Instagram Reels. ابحث عن Reels الرائجة بالكلمة المفتاحية، حمّل بصيغة MP4 HD — بدون علامة مائية، بدون تسجيل.',
        ogTitle: 'SaveMyReels - باحث ومحمّل Instagram Reels | مجاني',
        ogDescription: 'أفضل أداة مجانية للعثور على Instagram Reels. ابحث عن Reels الرائجة، حمّل بصيغة MP4 HD بدون علامة مائية.'
    }
};

function detectLanguage(request) {
    const acceptLanguage = request.headers.get('Accept-Language') || 'en';
    const primaryLang = acceptLanguage.split(',')[0].split('-')[0].toLowerCase();
    
    // Supported languages
    const supportedLangs = ['en', 'tr', 'de', 'es', 'fr', 'pt', 'ar'];
    return supportedLangs.includes(primaryLang) ? primaryLang : 'en';
}


export default class extends WorkerEntrypoint {
    async fetch(request) {
        const env = this.env;
        const url = new URL(request.url);

        if (url.pathname === '/api/download') {
            return handleDownload(request);
        }

        if (url.pathname === '/api/proxy-video') {
            return handleProxyVideo(request);
        }
        if (url.pathname === '/api/track-download') {
            return handleTrackDownload(request, env);
        }
        if (url.pathname === '/api/track-search') {
            return handleTrackSearch(request, env);
        }
        if (url.pathname === '/api/stats') {
            return handleStats(request, env);
        }

        // Get the asset response first
        const response = await env.ASSETS.fetch(request);

        // Only process HTML responses
        const contentType = response.headers.get('Content-Type') || '';
        if (!contentType.includes('text/html')) {
            return response;
        }

        // Detect language
        const lang = detectLanguage(request);
        const seo = seoTranslations[lang] || seoTranslations.en;

        // Use HTMLRewriter to modify meta tags
        return new HTMLRewriter()
            .on('title', {
                element(element) {
                    element.setInnerContent(seo.title);
                }
            })
            .on('meta[name="description"]', {
                element(element) {
                    element.setAttribute('content', seo.description);
                }
            })
            .on('meta[property="og:title"]', {
                element(element) {
                    element.setAttribute('content', seo.ogTitle);
                }
            })
            .on('meta[property="og:description"]', {
                element(element) {
                    element.setAttribute('content', seo.ogDescription);
                }
            })
            .on('meta[name="twitter:title"]', {
                element(element) {
                    element.setAttribute('content', seo.ogTitle);
                }
            })
            .on('meta[name="twitter:description"]', {
                element(element) {
                    element.setAttribute('content', seo.ogDescription);
                }
            })
            .on('html', {
                element(element) {
                    element.setAttribute('lang', lang);
                }
            })
            .transform(response);
    }
};
