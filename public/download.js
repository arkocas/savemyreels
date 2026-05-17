/**
 * Instagram Reel Downloader
 * Fetches video via local backend API proxy
 */

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
    
    if (!isValidInstagramUrl(url)) {
        showError('Please enter a valid Instagram Reel URL');
        return;
    }

    hideAll();
    downloadBtn.disabled = true;
    downloadBtn.textContent = '...';

    try {
        const response = await fetch(`/api/download?url=${encodeURIComponent(url)}`);
        const data = await response.json();

        if (data.error) {
            showError(data.error);
        } else if (data.video_url) {
            showResult(data);
        } else {
            showError('This post does not contain a video.');
        }
    } catch (err) {
        console.error(err);
        showError('Something went wrong. Please try again.');
    } finally {
        downloadBtn.disabled = false;
        // Restore button text from i18n
        if (typeof detectLanguage === 'function') {
            const lang = detectLanguage();
            const texts = { en: 'Download', tr: 'İndir', de: 'Herunterladen', es: 'Descargar', fr: 'Télécharger', pt: 'Baixar', ar: 'تحميل' };
            downloadBtn.textContent = texts[lang] || 'Download';
        } else {
            downloadBtn.textContent = 'Download';
        }
    }
}

function isValidInstagramUrl(url) {
    return /instagram\.com\/(reel|reels|p)\/[\w-]+/i.test(url);
}

function showResult(data) {
    hideAll();
    downloadResult.classList.remove('hidden');
    
    // Generate filename from caption or username
    let filename = 'reel';
    if (data.caption) {
        filename = data.caption
            .substring(0, 60)
            .replace(/[^\w\sğüşıöçĞÜŞİÖÇ-]/g, '')
            .replace(/\s+/g, '_')
            .trim();
    } else if (data.owner && data.owner.username) {
        filename = data.owner.username + '_' + data.shortcode;
    }
    if (!filename) filename = 'reel_' + data.shortcode;

    const proxyUrl = `/api/proxy-video?url=${encodeURIComponent(data.video_url)}`;
    
    downloadResult.innerHTML = `
        <div class="download-preview">
            <video src="${data.video_url}" controls playsinline poster="${data.thumbnail || ''}"></video>
        </div>
        <div class="download-info">
            ${data.owner ? `<p class="download-owner">@${escapeHtml(data.owner.username)}</p>` : ''}
            ${data.caption ? `<p class="download-caption">${escapeHtml(data.caption.substring(0, 100))}${data.caption.length > 100 ? '...' : ''}</p>` : ''}
        </div>
        <a href="${proxyUrl}" class="download-link" download="${escapeHtml(filename)}.mp4" onclick="trackDownload()">⬇️ Download Video</a>
    `;
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

function trackDownload() {
    fetch('/api/track-download', { method: 'POST' }).catch(() => {});
}
