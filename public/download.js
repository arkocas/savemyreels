/**
 * Instagram Reel Downloader
 * Fetches video via local backend API proxy
 */

// Helper to get translation (uses global translations from i18n.js)
function getTranslation(key) {
    if (typeof translations === 'undefined' || typeof detectLanguage === 'undefined') return null;
    const lang = detectLanguage();
    return translations[lang] && translations[lang][key] ? translations[lang][key] : (translations['en'] && translations['en'][key]) || null;
}

const reelUrlInput = document.getElementById('reel-url');
const downloadBtn = document.getElementById('download-btn');
const downloadResult = document.getElementById('download-result');
const downloadError = document.getElementById('download-error');

downloadBtn.addEventListener('click', handleDownload);
reelUrlInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') handleDownload();
});

async function handleDownload() {
    const url = reelUrlInput.value.trim();
    
    if (!url) return;
    
    const platform = window.currentPlatform || 'instagram';

    if (platform === 'instagram' && !isValidInstagramUrl(url)) {
        showError(getTranslation('error_invalid_url') || 'Please enter a valid Instagram Reel URL');
        return;
    } else if (platform === 'tiktok' && !isValidTikTokUrl(url)) {
        showError(getTranslation('error_invalid_url_tiktok') || 'Please enter a valid TikTok Video URL');
        return;
    }

    hideAll();
    downloadBtn.disabled = true;
    downloadBtn.textContent = '...';

    try {
        const apiEndpoint = platform === 'tiktok' ? '/api/download-tiktok' : '/api/download';
        const response = await fetch(`${apiEndpoint}?url=${encodeURIComponent(url)}`);
        const data = await response.json();

        if (data.error) {
            showError(data.error);
        } else if (data.video_url) {
            showResult(data, url, platform);
        } else {
            showError(getTranslation('error_no_video') || 'This post does not contain a video.');
        }
    } catch (err) {
        console.error(err);
        showError('Something went wrong. Please try again.');
    } finally {
        downloadBtn.disabled = false;
        // Restore button text from i18n
        if (typeof detectLanguage === 'function') {
            const lang = detectLanguage();
            const texts = { en: 'Download', tr: 'İndir', de: 'Herunterladen', es: 'Descargar', fr: 'Télécharger', pt: 'Baixar', ar: 'تحميل', hi: 'डाउनलोड करें' };
            downloadBtn.textContent = texts[lang] || 'Download';
        } else {
            downloadBtn.textContent = 'Download';
        }
    }
}

function isValidInstagramUrl(url) {
    return /instagram\.com\/(reel|reels|p)\/[\w-]+/i.test(url);
}

function isValidTikTokUrl(url) {
    return /^https?:\/\/(www\.)?(tiktok\.com\/(@[\w.-]+\/video\/\d+|discover\/[\w-]+)|vt\.tiktok\.com\/[\w/-]+|vm\.tiktok\.com\/[\w/-]+)/i.test(url);
}

function showResult(data, originalUrl, platform) {
    hideAll();
    downloadResult.classList.remove('hidden');
    
    // Generate filename
    let filename = platform === 'tiktok' ? 'tiktok' : 'reel';
    if (data.caption) {
        filename = data.caption
            .substring(0, 60)
            .replace(/[^\w\sğüşıöçĞÜŞİÖÇ-]/g, '')
            .replace(/\s+/g, '_')
            .trim();
    } else if (data.owner && data.owner.username) {
        filename = data.owner.username + '_' + (data.shortcode || data.id || 'video');
    }
    if (!filename) filename = `${platform}_` + (data.shortcode || data.id || Date.now());

    const proxyUrl = `/api/proxy-video?url=${encodeURIComponent(data.video_url)}&filename=${encodeURIComponent(filename)}`;

    // Build DOM instead of innerHTML to avoid escaping issues
    downloadResult.innerHTML = `
        <div class="download-preview">
            <video src="${data.video_url}" controls playsinline poster="${data.thumbnail || ''}"></video>
        </div>
        <div class="download-info">
            ${data.owner ? `<p class="download-owner">@${escapeHtml(data.owner.username)}</p>` : ''}
            ${data.caption ? `<p class="download-caption">${escapeHtml(data.caption.substring(0, 100))}${data.caption.length > 100 ? '...' : ''}</p>` : ''}
        </div>
    `;

    // Create download link via DOM — originalUrl is passed directly, no encoding issues
    const downloadLink = document.createElement('a');
    downloadLink.href = proxyUrl;
    downloadLink.className = 'download-link';
    downloadLink.download = filename + '.mp4';
    downloadLink.textContent = '⬇️ ' + (getTranslation('download_video') || 'Download Video');
    downloadLink.addEventListener('click', () => trackDownload(originalUrl, platform));
    downloadResult.appendChild(downloadLink);
}

function showError(msg) {
    hideAll();
    downloadError.classList.remove('hidden');
    downloadError.textContent = msg;
}

function hideAll() {
    downloadResult.classList.add('hidden');
    downloadError.classList.add('hidden');
}

function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

function trackDownload(videoUrl, platform) {
    fetch('/api/track-download', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ source: 'direct', url: videoUrl || '', platform: platform || 'instagram' })
    }).catch(() => {});
}
