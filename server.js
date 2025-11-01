import fetch from 'node-fetch';
import express from 'express';

const app = express();
const PORT = process.env.PORT || 3000;

// ⭐ キャッシュストアの定義
const videoCache = {};
// ⭐ キャッシュの有効期限を4時間 (ミリ秒) に設定
const CACHE_TTL = 4 * 60 * 60 * 1000; // 4 hours in milliseconds

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

/**
 * Invidiousレスポンスのフォーマットオブジェクトを、より汎用的な構造に変換し、トラックタイプを判別する。
 * (中略: normalizeFormat 関数は変更なし)
 */
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
    
    // 解像度の高さを数値で取得 (例: '1080p' -> 1080)
    const height = resolution ? parseInt(resolution.replace('p', '')) : 0;

    return {
        videoUrl: format.url,
        itag: format.itag, // 情報を残すためitagは含める
        qualityLabel: format.qualityLabel || format.quality,
        resolution: format.resolution,
        resolutionHeight: height,
        container: format.container,
        encoding: format.encoding,
        trackType: trackType,
        audioQuality: format.audioQuality // 音声トラック選定のため含める
    };
}


// ----------------------------------------------------
// getAllFormats 関数 (キャッシュ処理を含む)
// ----------------------------------------------------
/**
 * Invidiousインスタンスを巡回し、利用可能な全てのフォーマットを正規化して取得する。
 */
async function getAllFormats(videoId) {

    // 1. キャッシュの確認と有効期限チェック
    const cachedItem = videoCache[videoId];
    if (cachedItem && (Date.now() < cachedItem.timestamp + CACHE_TTL)) {
        console.log(`[${videoId}] キャッシュから取得したよ。`);
        return cachedItem.data;
    }

    for (const baseUrl of INVIDIOUS_INSTANCES) {
        const apiUrl = `${baseUrl}/api/v1/videos/${videoId}`;

        try {
            console.log(`[${videoId}] インスタンス試すよ: ${baseUrl}`);
            
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 7000); // 7秒のタイムアウト

            const response = await fetch(apiUrl, { signal: controller.signal });
            clearTimeout(timeoutId);

            if (!response.ok) {
                console.warn(`[${videoId}] ${baseUrl}から${response.status}って返ってきたわ。次行くね`);
                continue;
            }

            const data = await response.json();
            
            if (data && data.videoId === videoId) {
                
                const allFormats = [
                    ...(data.adaptiveFormats || []), 
                    ...(data.formatStreams || [])
                ];

                // 全てのフォーマットを正規化
                const normalizedFormats = allFormats
                    .map(normalizeFormat)
                    .filter(f => f.trackType !== 'unknown');
                
                if (normalizedFormats.length > 0) {
                    console.log(`[${videoId}] やった！${baseUrl}で${normalizedFormats.length}個のフォーマットを見つけたよ`);
                    
                    const result = {
                        success: true,
                        videoId: videoId,
                        instance: baseUrl,
                        title: data.title, // キャッシュ用にタイトルとサムネイルを取得
                        thumbnail: (data.videoThumbnails || []).find(t => t.quality === 'medium') || (data.videoThumbnails || [])[0],
                        formats: normalizedFormats
                    };

                    // 2. キャッシュに保存
                    videoCache[videoId] = {
                        timestamp: Date.now(),
                        data: result
                    };
                    
                    return result;
                } else {
                    console.log(`[${videoId}] ${baseUrl}には有効なフォーマットが無かったわ。次行くわ`);
                }
            } else {
                console.warn(`[${videoId}] ${baseUrl}から変なデータ返ってきたわ`);
            }

        } catch (error) {
            console.error(`[${videoId}] ${baseUrl}でエラー出た: ${error.message}`);
        }
    }

    return null; // 全てのインスタンスで失敗
}

// ----------------------------------------------------
// /stream/:id エンドポイント 
// ----------------------------------------------------
app.get('/stream/:id', async (req, res) => {
    const videoId = req.params.id;

    if (!videoId) {
        return res.status(400).json({ 
            error: 'videoIdが必要だよ。/stream/:id の形式でリクエストしてね。' 
        });
    }

    const result = await getAllFormats(videoId);
    
    if (!result) {
        return res.status(404).json({ 
            success: false, 
            error: `動画ID ${videoId} のストリームはどこにも無かったよ。` 
        });
    }

    const { formats } = result;
    
    // 互換性優先ロジック: 複合トラック (360p付近) を探す。
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
            message: "互換性を最優先し、複合トラック（360p付近）を厳選しました。",
            formats: [bestCombined]
        });
    }

    return res.status(200).json({
        success: result.success,
        videoId: result.videoId,
        instance: result.instance,
        message: "複合トラックが見つからなかったため、利用可能な全てのトラックを返します。",
        formats: formats
    });
});

// ----------------------------------------------------
// /high/:id エンドポイント (最高画質分離を優先、1080p制限、H.264優先)
// ----------------------------------------------------
app.get('/high/:id', async (req, res) => {
    const videoId = req.params.id;

    if (!videoId) {
        return res.status(400).json({ 
            error: 'videoIdが必要だよ。/high/:id の形式でリクエストしてね。' 
        });
    }

    const result = await getAllFormats(videoId);
    
    if (!result) {
        return res.status(404).json({ 
            success: false, 
            error: `動画ID ${videoId} のストリームはどこにも無かったよ。` 
        });
    }

    const { formats, videoId: resultVideoId, instance } = result;
    
    // 1. 分離トラック (Video/Audio) の厳選と1080p制限
    const videoTracks = formats
        .filter(f => f.trackType === 'video')
        .filter(f => {
            // ⭐ 1080p制限フィルタ: 1080p以下に限定。itag399 (4K) はここで除外される。
            return f.resolutionHeight > 0 && f.resolutionHeight <= 1080;
        })
        .sort((a, b) => {
            // 1. 解像度の高いものを優先
            if (a.resolutionHeight !== b.resolutionHeight) {
                return b.resolutionHeight - a.resolutionHeight; 
            }
            
            // ⭐ 2. 解像度が同じ場合、互換性の高いH.264を優先 (h264 > vp9)
            // これにより、同じ1080pでもVP9よりH.264が選ばれる。
            const isAH264 = (a.encoding || '').toLowerCase().includes('h.264') || (a.encoding || '').toLowerCase().includes('avc');
            const isBH264 = (b.encoding || '').toLowerCase().includes('h.264') || (b.encoding || '').toLowerCase().includes('avc');
            
            if (isAH264 && !isBH264) return -1;
            if (!isAH264 && isBH264) return 1;

            // 3. エンコーディングも同じ場合、itagの降順で代用
            return parseInt(b.itag) - parseInt(a.itag);
        });

    const audioTracks = formats
        .filter(f => f.trackType === 'audio')
        .sort((a, b) => {
            return parseInt(b.itag) - parseInt(a.itag);
        });
    
    const bestVideo = videoTracks[0] || null;
    const bestAudio = audioTracks[0] || null;

    // 2. 分離トラックのペアが見つかったかどうかのチェック
    if (bestVideo && bestAudio) {
        const finalResponse = {
            success: true,
            videoId: resultVideoId,
            instance: instance,
            message: "最高画質(1080p以下, H.264優先)と最高音質の分離トラックを1つずつ厳選しました。これらを結合して再生してください。",
            video: bestVideo, 
            audio: bestAudio  
        };
        return res.status(200).json(finalResponse);
    } 
    
    // 3. 分離トラックのペアが見つからなかった場合の代替処理 (複合トラックの提供)
    console.warn(`[${videoId}] 分離トラックのペアが見つかりませんでした。複合トラックを探します。`);
    
    const combinedTrack = formats
        .filter(f => f.trackType === 'combined')
        .filter(f => {
            // 複合トラックも1080p以下に制限
            return f.resolutionHeight > 0 && f.resolutionHeight <= 1080;
        })
        .sort((a, b) => {
            // 複合トラックは解像度降順で優先
            return b.resolutionHeight - a.resolutionHeight;
        })[0] || null;

    if (combinedTrack) {
        const finalResponse = {
            success: true,
            videoId: resultVideoId,
            instance: instance,
            message: "分離トラックが見つからなかったため、代替として最も高画質な複合トラック(1080p以下)を返します。",
            combined: combinedTrack
        };
        return res.status(200).json(finalResponse);
    }
    
    // 4. 複合トラックも見つからなかった場合、最終的なエラーを返す
    return res.status(404).json({ 
        success: false, 
        error: `動画ID ${videoId} のストリームは、分離トラックも複合トラックも全く見つかりませんでした。`,
        details: {
            message: "動画トラック、音声トラック、複合トラックのいずれも見つかりませんでした。",
            videoFound: !!bestVideo,
            audioFound: !!bestAudio,
            combinedFound: !!combinedTrack
        }
    });
});

// ----------------------------------------------------
// /api/cache エンドポイントの追加 (変更なし)
// ----------------------------------------------------
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

// ------------------------------------------

app.get('/', (req, res) => {
    res.status(200).send('Invidious Proxyは動いてるよ。動画データが欲しいなら /stream/:id (互換性重視) または /high/:id (最高画質/音質の分離を厳選) を使ってね。<br>キャッシュ一覧は <a href="/api/cache">/api/cache</a> で確認できるよ。');
});


app.listen(PORT, () => {
    console.log(`サーバーはポート${PORT}で起動したよ！`);
});
