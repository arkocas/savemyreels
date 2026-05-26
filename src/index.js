import { WorkerEntrypoint } from 'cloudflare:workers';

const IG_CONFIG = {
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    xIgAppId: '936619743392459'
};

function getShortcode(igUrl) {
    const regex = /instagram\.com\/(?:[A-Za-z0-9_.]+\/)?(p|reels|reel|stories)\/([A-Za-z0-9-_]+)/;
    const match = igUrl.match(regex);
    return match && match[2] ? match[2] : null;
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

    try {
        const body = new URLSearchParams({
            variables: JSON.stringify({ shortcode }),
            doc_id: '10015901848480474',
            lsd: 'AVqbxe3J_YA'
        });

        const response = await fetch('https://www.instagram.com/api/graphql', {
            method: 'POST',
            headers: {
                'User-Agent': IG_CONFIG.userAgent,
                'Content-Type': 'application/x-www-form-urlencoded',
                'X-IG-App-ID': IG_CONFIG.xIgAppId,
                'X-FB-LSD': 'AVqbxe3J_YA',
                'X-ASBD-ID': '129477',
                'Sec-Fetch-Site': 'same-origin'
            },
            body: body.toString()
        });

        if (!response.ok) {
            return Response.json({ error: `Instagram returned ${response.status}` }, { status: 502 });
        }

        const json = await response.json();
        const item = json?.data?.xdt_shortcode_media;

        if (!item) {
            return Response.json({ error: 'Could not fetch media data' }, { status: 404 });
        }

        return Response.json({
            shortcode: item.shortcode,
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
        });
    } catch (err) {
        return Response.json({ error: 'Failed to fetch data' }, { status: 500 });
    }
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
            headers: { 'User-Agent': IG_CONFIG.userAgent }
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
                'Cache-Control': 'no-cache'
            }
        });
    } catch (err) {
        return new Response('Proxy error', { status: 500 });
    }
}

async function handleTrackDownload(request, env) {
    if (request.method !== 'POST') {
        return Response.json({ error: 'Method not allowed' }, { status: 405 });
    }

    try {
        // Toplam indirme sayısını artır
        const current = parseInt(await env.STATS.get('download_count') || '0', 10);
        await env.STATS.put('download_count', String(current + 1));

        // Body'den source, query, url ve platform bilgisini al
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

        // Kaynağa göre sayaç tut
        const sourceKey = `download_source:${source}`;
        const sourceCount = parseInt(await env.STATS.get(sourceKey) || '0', 10);
        await env.STATS.put(sourceKey, String(sourceCount + 1));

        // Platform bazlı indirme sayacı
        const platformKey = `download_count:${platform}`;
        const platformCount = parseInt(await env.STATS.get(platformKey) || '0', 10);
        await env.STATS.put(platformKey, String(platformCount + 1));

        // Tüm indirmeleri URL ile birlikte kaydet (son 100)
        const allDownloadsRaw = await env.STATS.get('recent_downloads') || '[]';
        const allDownloads = JSON.parse(allDownloadsRaw);
        allDownloads.unshift({ url: reelUrl, source, platform, query: query || undefined, time: Date.now() });
        if (allDownloads.length > 100) allDownloads.length = 100;
        await env.STATS.put('recent_downloads', JSON.stringify(allDownloads));

        // Arama sonucundan indirildiyse hangi sorgudan geldiğini de kaydet
        if (source === 'search' && query) {
            const queryDownloadKey = `download_from_search:${query}`;
            const queryDownloadCount = parseInt(await env.STATS.get(queryDownloadKey) || '0', 10);
            await env.STATS.put(queryDownloadKey, String(queryDownloadCount + 1));

            const recentRaw = await env.STATS.get('recent_search_downloads') || '[]';
            const recent = JSON.parse(recentRaw);
            recent.unshift({ url: reelUrl, query, platform, time: Date.now() });
            if (recent.length > 50) recent.length = 50;
            await env.STATS.put('recent_search_downloads', JSON.stringify(recent));
        }

        return Response.json({ success: true, count: current + 1 });
    } catch (err) {
        return Response.json({ error: 'Failed to track' }, { status: 500 });
    }
}

async function handleTikTokDownload(request) {
    const url = new URL(request.url);
    const tiktokUrl = url.searchParams.get('url');

    if (!tiktokUrl) {
        return Response.json({ error: 'Missing url parameter' }, { status: 400 });
    }

    try {
        const response = await fetch('https://tikwm.com/api/?url=' + encodeURIComponent(tiktokUrl), {
            headers: {
                'User-Agent': IG_CONFIG.userAgent,
                'Accept': 'application/json'
            }
        });

        if (!response.ok) {
            return Response.json({ error: `TikTok API returned ${response.status}` }, { status: 502 });
        }

        const json = await response.json();

        if (json.code !== 0 || !json.data) {
            return Response.json({ error: json.msg || 'Could not fetch TikTok data' }, { status: 404 });
        }

        const item = json.data;

        // Note: TikWM play urls are often directly accessible or need proxy.
        // They sometimes redirect or return 403 if accessed directly from browser without proper headers.
        // Our proxy-video endpoint should handle it.

        return Response.json({
            id: item.id,
            is_video: true,
            video_url: item.play || null,
            thumbnail: item.cover,
            caption: item.title || '',
            owner: {
                username: item.author?.unique_id,
                full_name: item.author?.nickname,
            },
            video_duration: item.duration,
            view_count: item.play_count,
        });
    } catch (err) {
        return Response.json({ error: 'Failed to fetch TikTok data' }, { status: 500 });
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

        // Toplam arama sayısını artır
        const totalSearches = parseInt(await env.STATS.get('search_count') || '0', 10);
        await env.STATS.put('search_count', String(totalSearches + 1));

        // Platform bazlı arama sayacı
        const platformKey = `search_count:${platform}`;
        const platformCount = parseInt(await env.STATS.get(platformKey) || '0', 10);
        await env.STATS.put(platformKey, String(platformCount + 1));

        // Bu terimin sayısını artır
        const termKey = `search_term:${query}`;
        const termCount = parseInt(await env.STATS.get(termKey) || '0', 10);
        await env.STATS.put(termKey, String(termCount + 1));

        // Son aranan terimleri listede tut (son 50)
        const recentRaw = await env.STATS.get('recent_searches') || '[]';
        const recent = JSON.parse(recentRaw);
        recent.unshift({
            query,
            platform,
            time: Date.now()
        });
        if (recent.length > 50) recent.length = 50;
        await env.STATS.put('recent_searches', JSON.stringify(recent));

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
        const downloadCount = parseInt(await env.STATS.get('download_count') || '0', 10);
        const searchCount = parseInt(await env.STATS.get('search_count') || '0', 10);
        const downloadDirect = parseInt(await env.STATS.get('download_source:direct') || '0', 10);
        const downloadFromSearch = parseInt(await env.STATS.get('download_source:search') || '0', 10);

        // Platform bazlı arama sayaçları
        const igSearchCount = parseInt(await env.STATS.get('search_count:instagram') || '0', 10);
        const ttSearchCount = parseInt(await env.STATS.get('search_count:tiktok') || '0', 10);

        // Platform bazlı indirme sayaçları
        const igDownloadCount = parseInt(await env.STATS.get('download_count:instagram') || '0', 10);
        const ttDownloadCount = parseInt(await env.STATS.get('download_count:tiktok') || '0', 10);

        const recentSearchesRaw = await env.STATS.get('recent_searches') || '[]';
        const recentSearches = JSON.parse(recentSearchesRaw);

        const recentDownloadsRaw = await env.STATS.get('recent_downloads') || '[]';
        const recentDownloads = JSON.parse(recentDownloadsRaw);

        const recentSearchDownloadsRaw = await env.STATS.get('recent_search_downloads') || '[]';
        const recentSearchDownloads = JSON.parse(recentSearchDownloadsRaw);

        return Response.json({
            download_count: downloadCount,
            download_direct: downloadDirect,
            download_from_search: downloadFromSearch,
            search_count: searchCount,

            instagram_search_count: igSearchCount,
            tiktok_search_count: ttSearchCount,
            instagram_download_count: igDownloadCount,
            tiktok_download_count: ttDownloadCount,

            recent_searches: recentSearches,
            recent_downloads: recentDownloads,
            recent_search_downloads: recentSearchDownloads
        });
    } catch (err) {
        return Response.json({ error: 'Failed to get stats' }, { status: 500 });
    }
}

// SEO meta translations
const seoTranslations = {
    en: {
        title: 'SaveMyReels - Free Reels & TikTok Finder | Search & Download',
        description: 'Search and download Instagram Reels and TikToks for free. Find trending videos by keyword, download videos as MP4 — no watermark, no login required.',
        ogTitle: 'SaveMyReels - Search & Download Instagram & TikTok Free',
        ogDescription: 'Search and download Instagram Reels and TikToks for free. Find trending videos by keyword, download in MP4. No watermark, no login required.'
    },
    tr: {
        title: 'SaveMyReels - Ücretsiz Reels & TikTok Bulucu | Ara & İndir',
        description: 'Instagram Reels ve TikTok videolarını ücretsiz arayın ve indirin. Anahtar kelimeyle trend videolar bulun, MP4 olarak kaydedin — filigran yok, giriş gerekmez.',
        ogTitle: 'SaveMyReels - Instagram & TikTok Ara & İndir Ücretsiz',
        ogDescription: 'Instagram Reels ve TikTok videolarını ücretsiz arayın ve indirin. Trend videolar bulun, MP4 olarak kaydedin. Filigran yok, giriş gerekmez.'
    },
    de: {
        title: 'SaveMyReels - Kostenloser Reels & TikTok Finder | Suchen & Herunterladen',
        description: 'Instagram Reels und TikToks kostenlos suchen und herunterladen. Videos nach Stichwort finden, als MP4 speichern — kein Wasserzeichen, kein Login.',
        ogTitle: 'SaveMyReels - Instagram & TikTok Suchen & Herunterladen Kostenlos',
        ogDescription: 'Instagram Reels und TikToks kostenlos suchen und herunterladen. Videos nach Stichwort finden, als MP4 speichern. Kein Wasserzeichen, kein Login.'
    },
    es: {
        title: 'SaveMyReels - Buscador de Reels y TikTok Gratis | Buscar y Descargar',
        description: 'Busca y descarga Instagram Reels y TikToks gratis. Encuentra videos en tendencia, descarga como MP4 — sin marca de agua, sin login.',
        ogTitle: 'SaveMyReels - Buscar y Descargar Instagram y TikTok Gratis',
        ogDescription: 'Busca y descarga Instagram Reels y TikToks gratis. Encuentra videos en tendencia, descarga como MP4. Sin marca de agua, sin login.'
    },
    fr: {
        title: 'SaveMyReels - Chercheur de Reels et TikTok Gratuit | Rechercher et Télécharger',
        description: 'Recherchez et téléchargez des Instagram Reels et TikToks gratuitement. Trouvez des vidéos tendance, téléchargez en MP4 — sans filigrane, sans connexion.',
        ogTitle: 'SaveMyReels - Rechercher et Télécharger Instagram et TikTok Gratuit',
        ogDescription: 'Recherchez et téléchargez des Instagram Reels et TikToks gratuitement. Trouvez des vidéos tendance, téléchargez en MP4. Sans filigrane, sans connexion.'
    },
    pt: {
        title: 'SaveMyReels - Buscador de Reels e TikTok Grátis | Pesquisar e Baixar',
        description: 'Pesquise e baixe Instagram Reels e TikToks gratuitamente. Encontre vídeos em alta, baixe como MP4 — sem marca d\'água, sem login.',
        ogTitle: 'SaveMyReels - Pesquisar e Baixar Instagram e TikTok Grátis',
        ogDescription: 'Pesquise e baixe Instagram Reels e TikToks gratuitamente. Encontre vídeos em alta, baixe como MP4. Sem marca d\'água, sem login.'
    },
    ar: {
        title: 'SaveMyReels - محرك بحث Reels و TikTok مجاني | ابحث وحمّل',
        description: 'ابحث وحمّل Instagram Reels و TikToks مجاناً. ابحث عن الفيديوهات الرائجة، حمّل بصيغة MP4 — بدون علامة مائية، بدون تسجيل دخول.',
        ogTitle: 'SaveMyReels - ابحث وحمّل Instagram و TikTok مجاناً',
        ogDescription: 'ابحث وحمّل Instagram Reels و TikToks مجاناً. ابحث عن الفيديوهات الرائجة، حمّل بصيغة MP4. بدون علامة مائية، بدون تسجيل دخول.'
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
        if (url.pathname === '/api/download-tiktok') {
            return handleTikTokDownload(request);
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
