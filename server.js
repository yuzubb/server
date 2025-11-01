import fetch from 'node-fetch';
import express from 'express';

const app = express.Router();
const PORT = process.env.PORT || 3000;

const videoCache = {};
const CACHE_TTL = 4 * 60 * 60 * 1000;

const INVIDIOUS_INSTANCES = [
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
        container: format.container ? format.container.toLowerCase() : null,
        encoding: format.encoding ? format.encoding.toLowerCase() : null,
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
            return b.resolutionHeight - a.resolutionHeight; 
        })[0];
    }

    if (bestCombined) {
        return res.status(200).json({
            success: result.success,
            videoId: result.videoId,
            instance: result.instance,
            message: "互換性を最優先し、最も高画質な複合トラックを厳選したぜ。",
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
            error: 'videoIdが必要です。/high/:id の形式でリクエストしてください。' 
        });
    }

    // ユーザーの要望に基づき、外部APIのURLを変更
    const API_URL = `https://siawaseok.duckdns.org/api/stream/${videoId}/type2`;

    try {
        console.log(`[${videoId}] 新しいAPI (type2) を試します: ${API_URL}`);
        
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 7000);

        const response = await fetch(API_URL, { signal: controller.signal });
        clearTimeout(timeoutId);

        if (!response.ok) {
            console.error(`[${videoId}] ${API_URL}から${response.status}が返されました。`);
            return res.status(502).json({ 
                success: false, 
                error: `ストリーム情報取得に失敗しました。ステータスコード: ${response.status}` 
            });
        }

        const data = await response.json();
        
        // type2形式の構造 (m3u8フィールド) をチェック
        if (!data || !data.m3u8) {
            return res.status(404).json({ 
                success: false, 
                error: `動画ID ${videoId} の有効な type2 形式の m3u8 フォーマットは見つかりませんでした。` 
            });
        }
        
        const m3u8Formats = data.m3u8;
        
        let bestM3u8Url = null;
        let maxResolutionHeight = -1;
        let bestResolutionLabel = null;
        
        // m3u8Formats (例: {"256p": { ... }, "1280p": { ... }}) を反復処理し、最高画質のURLを抽出
        for (const resolutionLabel in m3u8Formats) {
            // 解像度ラベルから数値 (例: "1280p" -> 1280) を抽出
            const resMatch = resolutionLabel.match(/(\d+)/); 
            const height = resMatch ? parseInt(resMatch[1]) : 0;
            
            if (height > maxResolutionHeight) {
                // URLの取得パスは m3u8Formats[resolutionLabel].url.url を想定
                const currentUrl = m3u8Formats[resolutionLabel]?.url?.url; 
                
                if (currentUrl) {
                    maxResolutionHeight = height;
                    bestM3u8Url = currentUrl;
                    bestResolutionLabel = resolutionLabel;
                }
            }
        }
        
        if (bestM3u8Url) {
            
            console.log(`[${videoId}] 最高画質のm3u8 URL (${bestResolutionLabel}) を取得し、コンテンツをプロキシします。`);
            
            // M3U8コンテンツを直接取得してクライアントに返す (プロキシ処理)
            try {
                const manifestResponse = await fetch(bestM3u8Url);

                if (!manifestResponse.ok) {
                    console.error(`[${videoId}] M3U8マニフェストの取得に失敗しました: ${manifestResponse.status}`);
                    return res.status(502).json({ 
                        success: false, 
                        error: `M3U8マニフェストのプロキシに失敗しました。ステータスコード: ${manifestResponse.status}` 
                    });
                }

                res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
                res.setHeader('Cache-Control', 'public, max-age=3600'); 
                
                const manifestContent = await manifestResponse.text();
                return res.status(200).send(manifestContent);
                
            } catch (fetchError) {
                console.error(`[${videoId}] M3U8マニフェストの取得中にエラーが発生しました: ${fetchError.message}`);
                 return res.status(500).json({ 
                    success: false, 
                    error: 'M3U8マニフェストのプロキシ中にエラーが発生しました。', 
                    details: fetchError.message 
                });
            }
        }

        return res.status(404).json({ 
            success: false, 
            error: `動画ID ${videoId} のM3U8ストリームは、一つも見つからなかったぜ。`
        });

    } catch (error) {
        console.error(`[${videoId}] ストリーム情報取得中にエラーが発生しました: ${error.message}`);
        return res.status(500).json({ 
            success: false, 
            error: 'サーバー側でエラーが発生しました。', 
            details: error.message 
        });
    }
});

app.get('/api/stream/:id/type2', async (req, res) => {
    const videoId = req.params.id;

    if (!videoId) {
        return res.status(400).json({ 
            error: 'videoIdが必要です。/api/stream/:id/type2 の形式でリクエストしてください。' 
        });
    }

    const API_URL = `https://siawaseok.f5.si/api/streams/${videoId}`;

    try {
        console.log(`[${videoId}] type2データ取得を試みます: ${API_URL}`);
        
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 7000);

        const response = await fetch(API_URL, { signal: controller.signal });
        clearTimeout(timeoutId);

        if (!response.ok) {
            console.error(`[${videoId}] ${API_URL}から${response.status}が返されました。`);
            return res.status(502).json({ 
                success: false, 
                error: `ストリーム情報取得に失敗しました。ステータスコード: ${response.status}` 
            });
        }

        const data = await response.json();
        
        if (!data || !data.m3u8) {
            return res.status(404).json({ 
                success: false, 
                error: `動画ID ${videoId} の有効な type2 形式のフォーマットは見つかりませんでした。` 
            });
        }
        
        const m3u8Formats = data.m3u8;
        
        let bestM3u8Url = null;
        let maxResolutionHeight = -1;
        let bestResolutionLabel = null;
        
        for (const resolutionLabel in m3u8Formats) {
            const resMatch = resolutionLabel.match(/(\d+)/); 
            const height = resMatch ? parseInt(resMatch[1]) : 0;
            
            if (height > maxResolutionHeight) {
                const currentUrl = m3u8Formats[resolutionLabel]?.url?.url; 
                
                if (currentUrl) {
                    maxResolutionHeight = height;
                    bestM3u8Url = currentUrl;
                    bestResolutionLabel = resolutionLabel;
                }
            }
        }
        
        if (bestM3u8Url) {
            console.log(`[${videoId}] 最高画質のm3u8 URL (${bestResolutionLabel}) を抽出したぜ。`);
            
            return res.status(200).json({
                success: true,
                videoId: videoId,
                resolution: bestResolutionLabel,
                m3u8Url: bestM3u8Url,
                message: `最高画質のHLS (m3u8) マニフェストURL (${bestResolutionLabel}) を抽出したぜ。`
            });
        }

        return res.status(404).json({ 
            success: false, 
            error: `動画ID ${videoId} のM3U8ストリームは、一つも見つからなかったぜ。`
        });

    } catch (error) {
        console.error(`[${videoId}] ストリーム情報取得中にエラーが発生しました: ${error.message}`);
        return res.status(500).json({ 
            success: false, 
            error: 'サーバー側でエラーが発生しました。', 
            details: error.message 
        });
    }
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
                        <br><a href="/api/stream/${item.videoId}/type2" target="_blank">/api/stream/${item.videoId}/type2</a>
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
