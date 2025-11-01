import fetch from 'node-fetch';
import express from 'express';

const app = express.Router();
const PORT = process.env.PORT || 3000;

const videoCache = {};
const CACHE_TTL = 4 * 60 * 60 * 1000;

const INVIDIOUS_INSTANCES = [
    'https://invidious.f5.si',
    'https://yt.omada.cafe',
    'https://inv.perditum.com',
    'https://iv.melmac.space',
    'https://invidious.nikkosphere.com',
    'https://iv.duti.dev',
    'https://youtube.alt.tyil.nl',
    'https://inv.antopie.org',
    'https://lekker.gay',
];

function normalizeFormat(format) {
    const hasResolution = !!format.resolution || !!format.qualityLabel;
    const hasAudioQuality = !!format.audioQuality || !!(format.quality && format.quality.includes('audio'));

    let trackType = 'unknown';
    if (hasResolution && hasAudioQuality) {
        trackType = 'combined';
    } else if (hasResolution && !hasAudioQuality) {
        trackType = 'video';
    } else if (!hasResolution && hasAudioQuality) {
        trackType = 'audio';
    }

    const resolution = format.resolution || (format.qualityLabel ? format.qualityLabel.match(/(\d+p)/)?.[1] : null);
    
    const height = resolution ? parseInt(resolution.replace('p', '')) : 0;

    return {
        videoUrl: format.url,
        itag: format.itag,
        qualityLabel: format.qualityLabel || format.quality,
        resolution: format.resolution,
        resolutionHeight: height,
        container: format.container,
        encoding: format.encoding,
        trackType: trackType,
        audioQuality: format.audioQuality
    };
}

async function getAllFormats(videoId) {

    const cachedItem = videoCache[videoId];
    if (cachedItem && (Date.now() < cachedItem.timestamp + CACHE_TTL)) {
        console.log(`[${videoId}] キャッシュから取得したぜ。`);
        return cachedItem.data;
    }

    for (const baseUrl of INVIDIOUS_INSTANCES) {
        const apiUrl = `${baseUrl}/api/v1/videos/${videoId}`;

        try {
            console.log(`[${videoId}] インスタンス試すぜ: ${baseUrl}`);
            
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 7000);

            const response = await fetch(apiUrl, { signal: controller.signal });
            clearTimeout(timeoutId);

            if (!response.ok) {
                console.warn(`[${videoId}] ${baseUrl}から${response.status}って返ってきたわ。次行くぜ`);
                continue;
            }

            const data = await response.json();
            
            if (data && data.videoId === videoId) {
                
                const allFormats = [
                    ...(data.adaptiveFormats || []), 
                    ...(data.formatStreams || [])
                ];

                const normalizedFormats = allFormats
                    .map(normalizeFormat)
                    .filter(f => f.trackType !== 'unknown');
                
                if (normalizedFormats.length > 0) {
                    console.log(`[${videoId}] やった！${baseUrl}で${normalizedFormats.length}個のフォーマットを見つけたぜ`);
                    
                    const result = {
                        success: true,
                        videoId: videoId,
                        instance: baseUrl,
                        title: data.title,
                        thumbnail: (data.videoThumbnails || []).find(t => t.quality === 'medium') || (data.videoThumbnails || [])[0],
                        formats: normalizedFormats
                    };

                    videoCache[videoId] = {
                        timestamp: Date.now(),
                        data: result
                    };
                    
                    return result;
                } else {
                    console.log(`[${videoId}] ${baseUrl}には有効なフォーマットが無かったわ。次行くぜ`);
                }
            } else {
                console.warn(`[${videoId}] ${baseUrl}から変なデータ返ってきたぜ`);
            }

        } catch (error) {
            console.error(`[${videoId}] ${baseUrl}でエラー出たぜ: ${error.message}`);
        }
    }

    return null;
}

app.get('/stream/:id', async (req, res) => {
    const videoId = req.params.id;

    if (!videoId) {
        return res.status(400).json({ 
            error: 'videoIdが必要だぜ。/stream/:id の形式でリクエストしてくれ。' 
        });
    }

    const result = await getAllFormats(videoId);
    
    if (!result) {
        return res.status(404).json({ 
            success: false, 
            error: `動画ID ${videoId} のストリームはどこにも無かったぜ。` 
        });
    }

    const { formats } = result;
    
    const combinedTracks = formats.filter(f => f.trackType === 'combined');
    
    let bestCombined = null;

    if (combinedTracks.length > 0) {
        bestCombined = combinedTracks.sort((a, b) => {
            return a.resolutionHeight - b.resolutionHeight;
        }).find(f => f.resolutionHeight >= 360) || combinedTracks[0];
    }

    if (bestCombined) {
        return res.status(200).json({
            success: result.success,
            videoId: result.videoId,
            instance: result.instance,
            message: "互換性を最優先し、複合トラック（360p付近）を厳選したぜ。",
            formats: [bestCombined]
        });
    }

    return res.status(200).json({
        success: result.success,
        videoId: result.videoId,
        instance: result.instance,
        message: "複合トラックが見つからなかったから、利用可能な全てのトラックを返すぜ。",
        formats: formats
    });
});

app.get('/high/:id', async (req, res) => {
    const videoId = req.params.id;

    if (!videoId) {
        return res.status(400).json({ 
            error: 'videoIdが必要だぜ。/high/:id の形式でリクエストしてくれ。' 
        });
    }

    const result = await getAllFormats(videoId);
    
    if (!result) {
        return res.status(404).json({ 
            success: false, 
            error: `動画ID ${videoId} のストリームはどこにも無かったぜ。` 
        });
    }

    const { formats, videoId: resultVideoId, instance } = result;
    
    // 1. 動画トラック (H.264/MP4/1080p以下に厳格限定)
    const videoTracks = formats
        .filter(f => f.trackType === 'video')
        .filter(f => {
            if (f.itag === '399') {
                console.log(`[${f.videoId}] itag 399 は邪魔だから消したぜ。`);
                return false;
            }

            if (f.resolutionHeight > 1080 || f.resolutionHeight === 0) return false;

            const encoding = (f.encoding || '').toLowerCase();
            const container = (f.container || '').toLowerCase();

            if (!encoding.includes('avc') && !encoding.includes('h.264')) {
                return false;
            }
            if (container !== 'mp4') {
                return false;
            }

            return true;
        })
        .sort((a, b) => {
            if (a.resolutionHeight !== b.resolutionHeight) {
                return b.resolutionHeight - a.resolutionHeight; 
            }
            return parseInt(b.itag) - parseInt(a.itag);
        });

    // 2. 音声トラック (互換性の高いAAC/MP4を優先しつつ、Opusも許容)
    const audioTracks = formats
        .filter(f => f.trackType === 'audio')
        .filter(f => {
            const encoding = (f.encoding || '').toLowerCase();
            const container = (f.container || '').toLowerCase();

            // AAC (itag140など) または Opus (itag251など) のみを許可
            if (encoding.includes('aac') || encoding.includes('opus')) {
                return true;
            }

            return false;
        })
        .sort((a, b) => {
            // AAC (itag140) を優先するため、AAC判定に高いスコアを与える
            const aIsAAC = (a.encoding || '').toLowerCase().includes('aac');
            const bIsAAC = (b.encoding || '').toLowerCase().includes('aac');

            if (aIsAAC && !bIsAAC) return -1;
            if (!aIsAAC && bIsAAC) return 1;

            // それ以外はitagの降順で代用 (Opusトラックの品質を優先)
            return parseInt(b.itag) - parseInt(a.itag);
        });
    
    const bestVideo = videoTracks[0] || null;
    const bestAudio = audioTracks[0] || null;

    if (bestVideo && bestAudio) {
        const finalResponse = {
            success: true,
            videoId: resultVideoId,
            instance: instance,
            message: "H.264動画と互換性の高い音声トラック（AAC優先）で厳選したペアだぜ。",
            video: bestVideo, 
            audio: bestAudio  
        };
        return res.status(200).json(finalResponse);
    } 
    
    console.warn(`[${videoId}] 互換性最優先の分離トラックペア（H.264/AACまたはOpus）は見つからなかったぜ。`);
    
    // 3. 代替の複合トラックのフィルタリング
    const combinedTrack = formats
        .filter(f => f.trackType === 'combined')
        .filter(f => {
            // 複合トラックは、最も互換性の高いMP4コンテナに限定
            return f.resolutionHeight > 0 && f.resolutionHeight <= 1080 && (f.container || '').toLowerCase() === 'mp4';
        })
        .sort((a, b) => {
            return b.resolutionHeight - a.resolutionHeight;
        })[0] || null;

    if (combinedTrack) {
        const finalResponse = {
            success: true,
            videoId: resultVideoId,
            instance: instance,
            message: "分離トラックが見つからなかったから、代替として最も高画質な複合トラック(MP4/1080p以下)を返すぜ。",
            combined: combinedTrack
        };
        return res.status(200).json(finalResponse);
    }
    
    return res.status(404).json({ 
        success: false, 
        error: `動画ID ${videoId} のストリームは、タブレット互換性の高いトラックが一つも見つからなかったぜ。`,
        details: {
            message: "H.264動画トラックと、互換性の高い音声トラックのペア、または互換性の高い複合トラックが見つからなかった。",
            videoFound: !!bestVideo,
            audioFound: !!bestAudio,
            combinedFound: !!combinedTrack
        }
    });
});

app.get('/api/cache', (req, res) => {
    const cachedVideos = Object.keys(videoCache).map(videoId => {
        const item = videoCache[videoId];
        const expiresAt = item.timestamp + CACHE_TTL;
        const remainingTimeSeconds = Math.max(0, Math.floor((expiresAt - Date.now()) / 1000));
        
        const { title, thumbnail, instance } = item.data;

        return {
            videoId: videoId,
            title: title || 'タイトル不明',
            instance: instance,
            thumbnailUrl: thumbnail ? thumbnail.url : 'サムネイルなし',
            cachedAt: new Date(item.timestamp).toISOString(),
            expiresInSeconds: remainingTimeSeconds,
        };
    });

    const htmlOutput = `
        <!DOCTYPE html>
        <html lang="ja">
        <head>
            <meta charset="UTF-8">
            <title>Invidious Cache List</title>
            <style>
                body { font-family: sans-serif; line-height: 1.6; padding: 20px; }
                h1 { border-bottom: 2px solid #ccc; padding-bottom: 10px; }
                .cache-item { display: flex; align-items: center; margin-bottom: 20px; border: 1px solid #eee; padding: 10px; border-radius: 5px; }
                .cache-item img { margin-right: 15px; border-radius: 3px; width: 120px; height: auto; }
                .cache-info { font-size: 0.9em; }
                .cache-count { margin-bottom: 15px; font-weight: bold; }
                a { text-decoration: none; color: #0070c9; }
            </style>
        </head>
        <body>
            <h1>📦 Invidious Proxy キャッシュリスト</h1>
            <div class="cache-count">合計キャッシュ数: ${cachedVideos.length}</div>
            ${cachedVideos.map(item => `
                <div class="cache-item">
                    <img src="${item.thumbnailUrl}" alt="Thumbnail">
                    <div class="cache-info">
                        <strong>${item.title}</strong> (${item.videoId})<br>
                        キャッシュ元: <a href="${item.instance}" target="_blank">${new URL(item.instance).hostname}</a><br>
                        キャッシュ日時: ${new Date(item.cachedAt).toLocaleString()}<br>
                        有効期限まで: <span style="color:${item.expiresInSeconds < 600 ? 'red' : 'green'};">${Math.floor(item.expiresInSeconds / 3600)}時間${Math.floor((item.expiresInSeconds % 3600) / 60)}分${item.expiresInSeconds % 60}秒</span>
                        <br><a href="/high/${item.videoId}" target="_blank">/high/${item.videoId}</a>
                    </div>
                </div>
            `).join('')}
        </body>
        </html>
    `;

    res.status(200).send(htmlOutput);
});

express().use('/', app).listen(PORT, () => {
    console.log(`サーバーはポート${PORT}で起動したぜ！`);
});
