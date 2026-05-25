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

        // Body'den source, query ve url bilgisini al
        let source = 'direct';
        let query = '';
        let reelUrl = '';
        try {
            const body = await request.json();
            source = body.source || 'direct';
            query = (body.query || '').trim().toLowerCase().substring(0, 100);
            reelUrl = (body.url || '').trim().substring(0, 300);
        } catch (_) {}

        // Kaynağa göre sayaç tut
        const sourceKey = `download_source:${source}`;
        const sourceCount = parseInt(await env.STATS.get(sourceKey) || '0', 10);
        await env.STATS.put(sourceKey, String(sourceCount + 1));

        // Tüm indirmeleri URL ile birlikte kaydet (son 100)
        const allDownloadsRaw = await env.STATS.get('recent_downloads') || '[]';
        const allDownloads = JSON.parse(allDownloadsRaw);
        allDownloads.unshift({ url: reelUrl, source, query: query || undefined, time: Date.now() });
        if (allDownloads.length > 100) allDownloads.length = 100;
        await env.STATS.put('recent_downloads', JSON.stringify(allDownloads));

        // Arama sonucundan indirildiyse hangi sorgudan geldiğini de kaydet
        if (source === 'search' && query) {
            const queryDownloadKey = `download_from_search:${query}`;
            const queryDownloadCount = parseInt(await env.STATS.get(queryDownloadKey) || '0', 10);
            await env.STATS.put(queryDownloadKey, String(queryDownloadCount + 1));

            const recentRaw = await env.STATS.get('recent_search_downloads') || '[]';
            const recent = JSON.parse(recentRaw);
            recent.unshift({ url: reelUrl, query, time: Date.now() });
            if (recent.length > 50) recent.length = 50;
            await env.STATS.put('recent_search_downloads', JSON.stringify(recent));
        }

        return Response.json({ success: true, count: current + 1 });
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

        if (!query) {
            return Response.json({ error: 'Missing query' }, { status: 400 });
        }

        // Toplam arama sayısını artır
        const totalSearches = parseInt(await env.STATS.get('search_count') || '0', 10);
        await env.STATS.put('search_count', String(totalSearches + 1));

        // Bu terimin sayısını artır
        const termKey = `search_term:${query}`;
        const termCount = parseInt(await env.STATS.get(termKey) || '0', 10);
        await env.STATS.put(termKey, String(termCount + 1));

        // Son aranan terimleri listede tut (son 50)
        const recentRaw = await env.STATS.get('recent_searches') || '[]';
        const recent = JSON.parse(recentRaw);
        recent.unshift({ query, time: Date.now() });
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
        title: 'SaveMyReels - Download Instagram Reels Free, No Watermark | Reels Finder & Downloader',
        description: 'Download Instagram Reels for free — no watermark, no login required. Paste any Reel URL and save as MP4 in seconds. Also search and find Instagram Reels by keyword.',
        ogTitle: 'SaveMyReels - Download Instagram Reels Free, No Watermark',
        ogDescription: 'Download Instagram Reels for free — no watermark, no login. Paste the URL and save as MP4 instantly. Search Reels by keyword too.'
    },
    tr: {
        title: 'SaveMyReels - Instagram Reels İndir Filigransız & Ücretsiz | Reels Bulucu & İndirici',
        description: 'Instagram Reels\'leri ücretsiz indirin — filigran yok, giriş gerekmez. Reel URL\'sini yapıştırın ve saniyeler içinde MP4 olarak kaydedin. Ayrıca anahtar kelimeyle Reels arayın ve bulun.',
        ogTitle: 'SaveMyReels - Instagram Reels İndir Filigransız & Ücretsiz',
        ogDescription: 'Instagram Reels\'leri ücretsiz indirin — filigran yok, giriş gerekmez. URL\'yi yapıştırın ve anında MP4 olarak kaydedin.'
    },
    de: {
        title: 'SaveMyReels - Instagram Reels Herunterladen, Kein Wasserzeichen | Reels Finder & Downloader',
        description: 'Instagram Reels kostenlos herunterladen — kein Wasserzeichen, kein Login. Reel-URL einfügen und in Sekunden als MP4 speichern. Auch Reels nach Stichwort suchen und finden.',
        ogTitle: 'SaveMyReels - Instagram Reels Herunterladen, Kein Wasserzeichen',
        ogDescription: 'Instagram Reels kostenlos herunterladen — kein Wasserzeichen, kein Login. URL einfügen und sofort als MP4 speichern.'
    },
    es: {
        title: 'SaveMyReels - Descargar Instagram Reels Gratis, Sin Marca de Agua | Buscador de Reels',
        description: 'Descarga Instagram Reels gratis — sin marca de agua, sin login. Pega la URL del Reel y guárdalo como MP4 en segundos. También busca y encuentra Reels por palabra clave.',
        ogTitle: 'SaveMyReels - Descargar Instagram Reels Gratis, Sin Marca de Agua',
        ogDescription: 'Descarga Instagram Reels gratis — sin marca de agua, sin login. Pega la URL y guarda como MP4 al instante.'
    },
    fr: {
        title: 'SaveMyReels - Télécharger Instagram Reels Gratuit, Sans Filigrane | Chercheur de Reels',
        description: 'Téléchargez des Instagram Reels gratuitement — sans filigrane, sans connexion. Collez l\'URL du Reel et sauvegardez en MP4 en quelques secondes. Recherchez aussi des Reels par mot-clé.',
        ogTitle: 'SaveMyReels - Télécharger Instagram Reels Gratuit, Sans Filigrane',
        ogDescription: 'Téléchargez des Instagram Reels gratuitement — sans filigrane, sans connexion. Collez l\'URL et sauvegardez en MP4 instantanément.'
    },
    pt: {
        title: 'SaveMyReels - Baixar Instagram Reels Grátis, Sem Marca d\'Água | Buscador de Reels',
        description: 'Baixe Instagram Reels gratuitamente — sem marca d\'água, sem login. Cole a URL do Reel e salve como MP4 em segundos. Também pesquise e encontre Reels por palavra-chave.',
        ogTitle: 'SaveMyReels - Baixar Instagram Reels Grátis, Sem Marca d\'Água',
        ogDescription: 'Baixe Instagram Reels gratuitamente — sem marca d\'água, sem login. Cole a URL e salve como MP4 instantaneamente.'
    },
    ar: {
        title: 'SaveMyReels - تحميل Instagram Reels مجاناً بدون علامة مائية | محرك بحث Reels',
        description: 'حمّل Instagram Reels مجاناً — بدون علامة مائية، بدون تسجيل دخول. الصق رابط الـ Reel واحفظه بصيغة MP4 في ثوانٍ. ابحث أيضاً عن Reels بالكلمة المفتاحية.',
        ogTitle: 'SaveMyReels - تحميل Instagram Reels مجاناً بدون علامة مائية',
        ogDescription: 'حمّل Instagram Reels مجاناً — بدون علامة مائية، بدون تسجيل دخول. الصق الرابط واحفظ بصيغة MP4 فوراً.'
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
