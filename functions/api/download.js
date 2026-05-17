// Cloudflare Pages Function: /api/download?url=...
// Fetches Instagram Reel data via GraphQL (no cookie needed)

const IG_CONFIG = {
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    xIgAppId: '936619743392459'
};

function getShortcode(igUrl) {
    const regex = /instagram\.com\/(?:[A-Za-z0-9_.]+\/)?(p|reels|reel|stories)\/([A-Za-z0-9-_]+)/;
    const match = igUrl.match(regex);
    return match && match[2] ? match[2] : null;
}

export async function onRequestGet(context) {
    const url = new URL(context.request.url);
    const igUrl = url.searchParams.get('url');

    if (!igUrl) {
        return new Response(JSON.stringify({ error: 'Missing url parameter' }), {
            status: 400,
            headers: { 'Content-Type': 'application/json' }
        });
    }

    const shortcode = getShortcode(igUrl);
    if (!shortcode) {
        return new Response(JSON.stringify({ error: 'Invalid Instagram URL' }), {
            status: 400,
            headers: { 'Content-Type': 'application/json' }
        });
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
            return new Response(JSON.stringify({ error: `Instagram returned ${response.status}` }), {
                status: 502,
                headers: { 'Content-Type': 'application/json' }
            });
        }

        const json = await response.json();
        const item = json?.data?.xdt_shortcode_media;

        if (!item) {
            return new Response(JSON.stringify({ error: 'Could not fetch media data' }), {
                status: 404,
                headers: { 'Content-Type': 'application/json' }
            });
        }

        const data = {
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
        };

        return new Response(JSON.stringify(data), {
            headers: { 'Content-Type': 'application/json' }
        });

    } catch (err) {
        return new Response(JSON.stringify({ error: 'Failed to fetch data' }), {
            status: 500,
            headers: { 'Content-Type': 'application/json' }
        });
    }
}
