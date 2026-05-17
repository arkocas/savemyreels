// Cloudflare Pages Function: /api/proxy-video?url=...
// Proxies Instagram video for download (bypasses CORS)

export async function onRequestGet(context) {
    const url = new URL(context.request.url);
    const videoUrl = url.searchParams.get('url');
    const filename = url.searchParams.get('filename') || 'reel';

    if (!videoUrl) {
        return new Response('Missing url parameter', { status: 400 });
    }

    try {
        const response = await fetch(videoUrl, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
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
                'Cache-Control': 'no-cache'
            }
        });

    } catch (err) {
        return new Response('Proxy error', { status: 500 });
    }
}
