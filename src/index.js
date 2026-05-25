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
        title: 'SaveMyReels - Search & Download Instagram Reels Free | Instagram Reel Downloader',
        description: 'Search and download Instagram Reels for free. Find trending reels by keyword, download Instagram videos in MP4 format. No login required. Fast, free Instagram Reels search engine and downloader.',
        ogTitle: 'SaveMyReels - Search & Download Instagram Reels Free',
        ogDescription: 'Search and download Instagram Reels for free. Find trending reels by keyword, download videos in MP4. No login required.'
    },
    tr: {
        title: 'SaveMyReels - Instagram Reels Ara & İndir Ücretsiz | Instagram Reel İndirici',
        description: 'Instagram Reels\'leri ücretsiz arayın ve indirin. Anahtar kelimeye göre trend reels bulun, Instagram videolarını MP4 formatında indirin. Giriş gerekmez. Hızlı, ücretsiz Instagram Reels arama motoru ve indirici.',
        ogTitle: 'SaveMyReels - Instagram Reels Ara & İndir Ücretsiz',
        ogDescription: 'Instagram Reels\'leri ücretsiz arayın ve indirin. Anahtar kelimeye göre trend reels bulun, MP4 formatında video indirin. Giriş gerekmez.'
    },
    de: {
        title: 'SaveMyReels - Instagram Reels Suchen & Kostenlos Herunterladen | Instagram Reel Downloader',
        description: 'Instagram Reels kostenlos suchen und herunterladen. Finden Sie trendige Reels nach Stichwort, laden Sie Instagram-Videos im MP4-Format herunter. Keine Anmeldung erforderlich. Schnelle, kostenlose Instagram Reels-Suchmaschine und Downloader.',
        ogTitle: 'SaveMyReels - Instagram Reels Suchen & Kostenlos Herunterladen',
        ogDescription: 'Instagram Reels kostenlos suchen und herunterladen. Finden Sie trendige Reels nach Stichwort, laden Sie Videos im MP4-Format herunter. Keine Anmeldung erforderlich.'
    },
    es: {
        title: 'SaveMyReels - Buscar y Descargar Instagram Reels Gratis | Descargador de Instagram Reels',
        description: 'Busca y descarga Instagram Reels gratis. Encuentra reels en tendencia por palabra clave, descarga videos de Instagram en formato MP4. No requiere inicio de sesión. Motor de búsqueda y descargador de Instagram Reels rápido y gratuito.',
        ogTitle: 'SaveMyReels - Buscar y Descargar Instagram Reels Gratis',
        ogDescription: 'Busca y descarga Instagram Reels gratis. Encuentra reels en tendencia por palabra clave, descarga videos en MP4. No requiere inicio de sesión.'
    },
    fr: {
        title: 'SaveMyReels - Rechercher et Télécharger Instagram Reels Gratuit | Téléchargeur Instagram Reels',
        description: 'Recherchez et téléchargez des Instagram Reels gratuitement. Trouvez des reels tendance par mot-clé, téléchargez des vidéos Instagram au format MP4. Aucune connexion requise. Moteur de recherche et téléchargeur Instagram Reels rapide et gratuit.',
        ogTitle: 'SaveMyReels - Rechercher et Télécharger Instagram Reels Gratuit',
        ogDescription: 'Recherchez et téléchargez des Instagram Reels gratuitement. Trouvez des reels tendance par mot-clé, téléchargez des vidéos en MP4. Aucune connexion requise.'
    },
    pt: {
        title: 'SaveMyReels - Pesquisar e Baixar Instagram Reels Grátis | Baixador de Instagram Reels',
        description: 'Pesquise e baixe Instagram Reels gratuitamente. Encontre reels em alta por palavra-chave, baixe vídeos do Instagram em formato MP4. Não requer login. Motor de busca e baixador de Instagram Reels rápido e gratuito.',
        ogTitle: 'SaveMyReels - Pesquisar e Baixar Instagram Reels Grátis',
        ogDescription: 'Pesquise e baixe Instagram Reels gratuitamente. Encontre reels em alta por palavra-chave, baixe vídeos em MP4. Não requer login.'
    },
    ar: {
        title: 'SaveMyReels - ابحث وحمّل Instagram Reels مجاناً | أداة تحميل Instagram Reels',
        description: 'ابحث وحمّل Instagram Reels مجاناً. ابحث عن الريلز الرائجة بالكلمة المفتاحية، حمّل فيديوهات Instagram بصيغة MP4. لا يتطلب تسجيل دخول. محرك بحث وأداة تحميل Instagram Reels سريعة ومجانية.',
        ogTitle: 'SaveMyReels - ابحث وحمّل Instagram Reels مجاناً',
        ogDescription: 'ابحث وحمّل Instagram Reels مجاناً. ابحث عن الريلز الرائجة بالكلمة المفتاحية، حمّل الفيديوهات بصيغة MP4. لا يتطلب تسجيل دخول.'
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
