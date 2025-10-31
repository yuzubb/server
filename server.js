import fetch from 'node-fetch';
import express from 'express';

const app = express();
const PORT = process.env.PORT || 3000;

// キャッシュ関連の定義を削除

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

// ⭐ 廃止: TARGET_ITAGS_ALL_OTHER
// ⭐ 廃止: TARGET_ITAGS_HIGH

/**
 * Invidiousレスポンスのフォーマットオブジェクトを、より汎用的な構造に変換し、トラックタイプを判別する。
 * @param {object} format - Invidious APIから取得した単一のフォーマットオブジェクト
 * @returns {object} 整理されたフォーマット情報
 */
function normalizeFormat(format) {
    const isAudioOnly = !!format.audioQuality && !format.resolution;
    const isVideoOnly = !!format.resolution && !format.audioQuality;
    const isCombined = !!format.resolution && !!format.audioQuality; // 解像度と音声品質の両方があれば複合と見なす

    let trackType = 'unknown';
    if (isAudioOnly) {
        trackType = 'audio';
    } else if (isVideoOnly) {
        trackType = 'video';
    } else if (isCombined) {
        trackType = 'combined';
    }

    const resolution = format.resolution || (format.qualityLabel ? format.qualityLabel.match(/(\d+p)/)?.[1] : null);
    
    // 解像度の高さを数値で取得 (例: '1080p' -> 1080, '720p' -> 720)
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
// getAllFormats 関数 (itagに依存しないように変更)
// ----------------------------------------------------
/**
 * Invidiousインスタンスを巡回し、利用可能な全てのフォーマットを正規化して取得する。
 */
async function getAllFormats(videoId) {

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
                    // typeが不明なものを除外
                    .filter(f => f.trackType !== 'unknown');
                
                if (normalizedFormats.length > 0) {
                    console.log(`[${videoId}] やった！${baseUrl}で${normalizedFormats.length}個のフォーマットを見つけたよ`);
                    return {
                        success: true,
                        videoId: videoId,
                        instance: baseUrl,
                        formats: normalizedFormats
                    };
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
// /stream/:id エンドポイント (互換性/18相当を優先)
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
    
    // ⭐ 互換性優先ロジック:
    // 1. 複合トラック ('combined') の中から、最も広く互換性のある (例: 360p) トラックを探す。
    const combinedTracks = formats.filter(f => f.trackType === 'combined');
    
    let bestCombined = null;

    if (combinedTracks.length > 0) {
        // 複合トラックを、解像度が低い順にソート（互換性優先のため）
        bestCombined = combinedTracks.sort((a, b) => {
            // 解像度の数値で昇順ソート (360p, 480p, 720p...)
            return a.resolutionHeight - b.resolutionHeight;
        }).find(f => f.resolutionHeight >= 360) || combinedTracks[0]; // 360p以上を優先、なければ最小のものを採用
    }

    if (bestCombined) {
        // 互換性の高い複合トラックが見つかったら、それだけを返す
        return res.status(200).json({
            ...result,
            message: "互換性を最優先し、複合トラック（360p付近）を厳選しました。",
            formats: [bestCombined]
        });
    }

    // 複合トラックが見つからない場合は、全てのトラックを返す（フォールバック）
    return res.status(200).json({
        ...result,
        message: "複合トラックが見つからなかったため、利用可能な全てのトラックを返します。",
        formats: formats
    });
});

// ----------------------------------------------------
// /high/:id エンドポイント (最高画質分離を優先、1080p制限)
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
            // ⭐ 1080p制限フィルター: 縦解像度が1080ピクセル以下であることを確認
            return f.resolutionHeight > 0 && f.resolutionHeight <= 1080;
        })
        .sort((a, b) => {
            // 解像度の高いもの（1080pが最高）を優先的に選択
            if (a.resolutionHeight !== b.resolutionHeight) {
                return b.resolutionHeight - a.resolutionHeight; 
            }
            // 解像度が同じなら、エンコーディング(VP9/h264)やitagで優先度を付けるのが理想だが、ここではitagの降順で代用
            return parseInt(b.itag) - parseInt(a.itag);
        });

    const audioTracks = formats
        .filter(f => f.trackType === 'audio')
        .sort((a, b) => {
            // 音声品質 (例: "AUDIO_QUALITY_HIGH") や itagでソート（高品質なものを優先）
            // 簡略化のため、ここではitagの降順でソート
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
            message: "最高画質(1080p以下)と最高音質の分離トラックを1つずつ厳選しました。これらを結合して再生してください。",
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
// ------------------------------------------

app.get('/', (req, res) => {
    res.status(200).send('Invidious Proxyは動いてるよ。動画データが欲しいなら /stream/:id (互換性重視) または /high/:id (最高画質/音質の分離を厳選) を使ってね。');
});


app.listen(PORT, () => {
    console.log(`サーバーはポート${PORT}で起動したよ！`);
});
