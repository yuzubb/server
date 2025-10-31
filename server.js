import fetch from 'node-fetch';
import express from 'express';

const app = express();
const PORT = process.env.PORT || 3000;

// キャッシュ設定
const videoCache = new Map();
const CACHE_DURATION_MS = 4 * 60 * 60 * 1000; // 4時間 (ミリ秒)

// Invidious インスタンスリスト
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

// ⭐ 変更点 1: itagリストを更新

// /stream/ で使用 (複合 18, 22 を含む、互換性重視の全フォーマット)
const TARGET_ITAGS_ALL = [
    '18', '22', '248', '271', '313', '315', '272',  // 動画 (複合と分離)
    '137', '299', '399', '264', '266',             // 動画 (分離)
    '251', '250', '249', '140', '141', '258'       // 音声
];

// /high/ で使用 (複合 18, 22 を含まない、高画質分離重視の全フォーマット)
const TARGET_ITAGS_HIGH = [
    '248', '271', '313', '315', '272',  // 動画のみ (VP9)
    '137', '299', '399', '264', '266',  // 動画のみ (H.264)
    '251', '250', '249', '140', '141', '258'  // 音声のみ (Opus/AAC)
];

// ----------------------------------------------------
// ⭐ 変更点 2: getAllTargetFormats はそのまま
// ----------------------------------------------------
async function getAllTargetFormats(videoId, targetItags) {
    for (const baseUrl of INVIDIOUS_INSTANCES) {
        const apiUrl = `${baseUrl}/api/v1/videos/${videoId}`;
        const foundFormats = [];

        try {
            console.log(`[${videoId}] インスタンス試すよ: ${baseUrl}`);
            
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 7000); 

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

                // 受け取った targetItags リストを使用
                for (const targetItag of targetItags) { 
                    const format = allFormats.find(f => f.itag === targetItag);
                    
                    if (format) {
                        
                        const isAudioOnly = !!format.audioQuality;
                        const isVideoOnly = !!format.qualityLabel && !format.audioQuality;
                        const isCombined = format.itag === '18' || format.itag === '22';
                        
                        foundFormats.push({
                            videoUrl: format.url,
                            itag: format.itag,
                            qualityLabel: format.qualityLabel || format.quality,
                            resolution: format.resolution,
                            container: format.container,
                            encoding: format.encoding,
                            trackType: isAudioOnly ? 'audio' : (isVideoOnly ? 'video' : (isCombined ? 'combined' : 'unknown'))
                        });
                    }
                }
                
                if (foundFormats.length > 0) {
                    console.log(`[${videoId}] やった！${baseUrl}でitag ${foundFormats.map(f => f.itag).join(', ')}を見つけたよ`);
                    return {
                        success: true,
                        videoId: videoId,
                        instance: baseUrl,
                        formats: foundFormats
                    };
                } else {
                    console.log(`[${videoId}] ${baseUrl}には目的のitag(${targetItags.join(', ')})が無かったわ。次行くわ`);
                }
            } else {
                console.warn(`[${videoId}] ${baseUrl}から変なデータ返ってきたわ`);
            }

        } catch (error) {
            console.error(`[${videoId}] ${baseUrl}でエラー出た: ${error.message}`);
        }
    }

    return null;
}

// ----------------------------------------------------
// /stream/:id エンドポイント (全フォーマット取得/キャッシュ保存用)
// ----------------------------------------------------
app.get('/stream/:id', async (req, res) => {
    const videoId = req.params.id;

    if (!videoId) {
        return res.status(400).json({ 
            error: 'videoIdが必要だよ。/stream/:id の形式でリクエストしてね。' 
        });
    }

    const cachedItem = videoCache.get(videoId);
    let result = null;
    
    // キャッシュが有効なら利用
    if (cachedItem && cachedItem.expiry > Date.now()) {
        console.log(`[${videoId}] キャッシュヒット！4時間以内だから即返すわ`);
        result = cachedItem.data;
    } else {
        // TARGET_ITAGS_ALL を渡す
        result = await getAllTargetFormats(videoId, TARGET_ITAGS_ALL);
        
        if (result) {
            videoCache.set(videoId, {
                data: result,
                expiry: Date.now() + CACHE_DURATION_MS
            });
            console.log(`[${videoId}] 新しい結果をキャッシュに保存したよ。4時間有効ね`);
        } else {
            return res.status(404).json({ 
                success: false, 
                error: `動画ID ${videoId} のストリームはどこにも無かったよ。` 
            });
        }
    }

    // /stream/ はフィルタリングせず、取得した全フォーマットを返す
    return res.status(200).json(result);
});

// ----------------------------------------------------
// ⭐ 変更点 3: /high/:id エンドポイント (最高画質/最高音質の厳選1つ)
// ----------------------------------------------------
app.get('/high/:id', async (req, res) => {
    const videoId = req.params.id;

    if (!videoId) {
        return res.status(400).json({ 
            error: 'videoIdが必要だよ。/high/:id の形式でリクエストしてね。' 
        });
    }

    const cachedItem = videoCache.get(videoId); 
    let result = null;
    
    // 1. まずキャッシュチェック
    if (cachedItem && cachedItem.expiry > Date.now()) {
        // キャッシュヒット時は、キャッシュデータを使って処理を続行
        console.log(`[${videoId}] キャッシュヒット！最高画質/音質を厳選するわ`);
        result = cachedItem.data; 
    } else {
        // 2. キャッシュがない、または期限切れの場合はデータ取得
        // TARGET_ITAGS_HIGH を渡す
        result = await getAllTargetFormats(videoId, TARGET_ITAGS_HIGH);
        
        if (result) {
            videoCache.set(videoId, {
                data: result,
                expiry: Date.now() + CACHE_DURATION_MS
            });
            console.log(`[${videoId}] 新しい結果をキャッシュに保存したよ。4時間有効ね`);
        } else {
            return res.status(404).json({ 
                success: false, 
                error: `動画ID ${videoId} の高画質ストリームはどこにも無かったよ。` 
            });
        }
    }

    // 3. 取得した結果（キャッシュまたは新規取得）をフィルタリングして厳選
    const { success, videoId: resultVideoId, instance, formats } = result;
    
    // 独立した動画トラックを解像度順にソート (降順)
    const videoTracks = formats
        .filter(f => f.trackType === 'video')
        .sort((a, b) => {
            // 解像度の高さを比較 (例: '1920x1080' から 1080 を抽出して比較)
            const resA = parseInt((a.resolution || '0x0').split('x')[1]);
            const resB = parseInt((b.resolution || '0x0').split('x')[1]);
            // 解像度が同じ場合は itag の番号（一般的に新しい高画質）で比較
            if (resA === resB) {
                return parseInt(b.itag) - parseInt(a.itag);
            }
            return resB - resA;
        });

    // 独立した音声トラックをビットレート相当でソート (降順)
    const audioTracks = formats
        .filter(f => f.trackType === 'audio')
        .sort((a, b) => {
            // itag番号で比較 (258, 251, 141, 140...)
            return parseInt(b.itag) - parseInt(a.itag);
        });
    
    // 厳選: 最高の動画トラックと最高の音声トラックを1つずつ選択
    const bestVideo = videoTracks[0] || null;
    const bestAudio = audioTracks[0] || null;

    if (!bestVideo || !bestAudio) {
         return res.status(404).json({ 
            success: false, 
            error: `動画ID ${videoId} の**分離された**最高画質/音質トラックのペアが見つかりませんでした。`,
            details: {
                message: "動画トラックと音声トラックの両方が揃いませんでした。",
                videoFound: !!bestVideo,
                audioFound: !!bestAudio
            }
        });
    }

    const finalResponse = {
        success: true,
        videoId: resultVideoId,
        instance: instance,
        message: "最高画質と最高音質のトラックを1つずつ厳選しました。これらを結合して再生してください。",
        video: bestVideo, // 最高の動画トラック (厳選1つ)
        audio: bestAudio  // 最高の音声トラック (厳選1つ)
    };

    return res.status(200).json(finalResponse);
});
// ------------------------------------------

app.get('/', (req, res) => {
    res.status(200).send('Invidious Proxyは動いてるよ。動画データが欲しいなら /stream/:id (全フォーマット) または /high/:id (最高画質/音質の分離を厳選) を使ってね。');
});


app.listen(PORT, () => {
    console.log(`サーバーはポート${PORT}で起動したよ！`);
});

// AbortControllerのインポートがない場合は、ご自身の環境に合わせて追加してください。
// import { AbortController } from 'node-fetch';
