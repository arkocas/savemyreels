const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');

const PORT = 3001;

// MIME types
const mimeTypes = {
    '.html': 'text/html',
    '.css': 'text/css',
    '.js': 'application/javascript',
    '.json': 'application/json',
    '.xml': 'application/xml',
    '.txt': 'text/plain',
    '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon'
};

// Instagram GraphQL scraper config
const IG_CONFIG = {
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    xIgAppId: '936619743392459'
};

// Extract shortcode from Instagram URL
function getShortcode(igUrl) {
    const regex = /instagram\.com\/(?:[A-Za-z0-9_.]+\/)?(p|reels|reel|stories)\/([A-Za-z0-9-_]+)/;
    const match = igUrl.match(regex);
    return match && match[2] ? match[2] : null;
}

// Fetch Instagram data via GraphQL
async function fetchInstagramData(igUrl) {
    const shortcode = getShortcode(igUrl);
    if (!shortcode) return { error: 'Invalid Instagram URL' };

    const graphqlUrl = new URL('https://www.instagram.com/api/graphql');
    const body = new URLSearchParams({
        variables: JSON.stringify({ shortcode }),
        doc_id: '10015901848480474',
        lsd: 'AVqbxe3J_YA'
    });

    const response = await fetch(graphqlUrl, {
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
        return { error: `Instagram returned ${response.status}` };
    }

    const json = await response.json();
    const item = json?.data?.xdt_shortcode_media;

    if (!item) return { error: 'Could not fetch media data' };

    return {
        shortcode: item.shortcode,
        is_video: item.is_video,
        video_url: item.video_url || null,
        thumbnail: item.display_url || item.thumbnail_src,
        caption: item.edge_media_to_caption?.edges?.[0]?.node?.text || '',
        owner: {
            username: item.owner?.username,
            full_name: item.owner?.full_name,
            profile_pic: item.owner?.profile_pic_url
        },
        video_duration: item.video_duration,
        view_count: item.video_view_count || item.video_play_count,
        dimensions: item.dimensions
    };
}

// HTTP Server
const server = http.createServer(async (req, res) => {
    const parsedUrl = url.parse(req.url, true);
    const pathname = parsedUrl.pathname;

    // API endpoint: /api/download?url=...
    if (pathname === '/api/download' && req.method === 'GET') {
        const igUrl = parsedUrl.query.url;
        
        if (!igUrl) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Missing url parameter' }));
            return;
        }

        try {
            const data = await fetchInstagramData(igUrl);
            res.writeHead(200, { 
                'Content-Type': 'application/json',
                'Access-Control-Allow-Origin': '*'
            });
            res.end(JSON.stringify(data));
        } catch (err) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Failed to fetch data' }));
        }
        return;
    }

    // API endpoint: /api/proxy-video?url=... (proxy video for download)
    if (pathname === '/api/proxy-video' && req.method === 'GET') {
        const videoUrl = parsedUrl.query.url;
        
        if (!videoUrl) {
            res.writeHead(400, { 'Content-Type': 'text/plain' });
            res.end('Missing url parameter');
            return;
        }

        try {
            const videoResponse = await fetch(videoUrl, {
                headers: { 'User-Agent': IG_CONFIG.userAgent }
            });

            if (!videoResponse.ok) {
                res.writeHead(502, { 'Content-Type': 'text/plain' });
                res.end('Failed to fetch video');
                return;
            }

            res.writeHead(200, {
                'Content-Type': 'video/mp4',
                'Content-Disposition': 'attachment; filename="reel.mp4"',
                'Access-Control-Allow-Origin': '*'
            });

            const reader = videoResponse.body.getReader();
            const pump = async () => {
                while (true) {
                    const { done, value } = await reader.read();
                    if (done) break;
                    res.write(value);
                }
                res.end();
            };
            await pump();
        } catch (err) {
            res.writeHead(500, { 'Content-Type': 'text/plain' });
            res.end('Proxy error');
        }
        return;
    }

    // Static file serving
    let filePath = pathname === '/' ? '/index.html' : pathname;
    filePath = path.join(__dirname, filePath);

    const ext = path.extname(filePath);
    const contentType = mimeTypes[ext] || 'application/octet-stream';

    try {
        const content = fs.readFileSync(filePath);
        const headers = {
            'Content-Type': contentType,
            'X-Content-Type-Options': 'nosniff',
            'X-Frame-Options': 'SAMEORIGIN',
            'Referrer-Policy': 'strict-origin-when-cross-origin'
        };
        // Cache static assets
        if (ext === '.css' || ext === '.js') {
            headers['Cache-Control'] = 'public, max-age=86400';
        } else if (ext === '.html') {
            headers['Cache-Control'] = 'public, max-age=3600';
        }
        res.writeHead(200, headers);
        res.end(content);
    } catch {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('Not Found');
    }
});

server.listen(PORT, () => {
    console.log(`🎬 Reels Finder running at http://localhost:${PORT}`);
});
