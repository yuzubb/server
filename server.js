import fetch from 'node-fetch';
import express from 'express';

const app = express();
const PORT = process.env.PORT || 3000;

const videoCache = new Map();
const CACHE_DURATION_MS = 4 * 60 * 60 * 1000; // 4時間 (ミリ秒)

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

// ⭐ 変更点 1: itagリストを2種類に分離

// /stream/ で使用 (itag 18を含む、互換性重視)
const TARGET_ITAGS_ALL = ['18'];

// /high/ で使用 (itag 18を含まない、高画質分離重視)
const TARGET_ITAGS_HIGH = ['399','299','248','137','247','140','249','250','251'];

// ⭐ 変更点 2: 使用するitagリストを引数として受け取るように変更
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
                        // itag 18がある場合は 'combined' になる
                        const isCombined = format.itag === '18';
                        
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

// /stream/:id エンドポイント (TARGET_ITAGS_ALL を使用)
app.get('/stream/:id', async (req, res) => {
    const videoId = req.params.id;

    if (!videoId) {
        return res.status(400).json({ 
            error: 'videoIdが必要だよ。/stream/:id の形式でリクエストしてね。' 
        });
    }

    const cachedItem = videoCache.get(videoId);
    
    // キャッシュヒットした場合
    if (cachedItem && cachedItem.expiry > Date.now()) {
        console.log(`[${videoId}] キャッシュヒット！4時間以内だから即返すわ`);
        // キャッシュデータが古い仕様で保存されている可能性を考慮し、再取得のトリガーにはしない
        // ここでは単純にキャッシュを返す
        return res.status(200).json(cachedItem.data);
    }

    // ⭐ TARGET_ITAGS_ALL を渡す
    const result = await getAllTargetFormats(videoId, TARGET_ITAGS_ALL);

    if (result) {
        videoCache.set(videoId, {
            data: result,
            expiry: Date.now() + CACHE_DURATION_MS
        });
        console.log(`[${videoId}] 新しい結果をキャッシュに保存したよ。4時間有効ね`);

        return res.status(200).json(result);
    } else {
        return res.status(404).json({ 
            success: false, 
            error: `動画ID ${videoId} のストリームはどこにも無かったよ。` 
        });
    }
});

// /high/:id エンドポイント (TARGET_ITAGS_HIGH を使用)
app.get('/high/:id', async (req, res) => {
    const videoId = req.params.id;

    if (!videoId) {
        return res.status(400).json({ 
            error: 'videoIdが必要だよ。/high/:id の形式でリクエストしてね。' 
        });
    }

    const cachedItem = videoCache.get(videoId); 
    let result = null;
    
    if (cachedItem && cachedItem.expiry > Date.now()) {
        // キャッシュヒット時は、キャッシュデータを使って処理を続行
        result = cachedItem.data; 
    } else {
        // ⭐ TARGET_ITAGS_HIGH を渡す
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

    // 取得した結果をフィルタリングして整理
    const { success, videoId: resultVideoId, instance, formats } = result;
    
    // /high/ では itag 18 を含まないため、結合トラックを探す必要はほぼないが、ロジックは分離に特化
    
    // 独立した動画トラックを解像度順にソート (降順)
    const videoTracks = formats
        .filter(f => f.trackType === 'video')
        .sort((a, b) => {
            const resA = parseInt((a.resolution || '0x0').split('x')[1]);
            const resB = parseInt((b.resolution || '0x0').split('x')[1]);
            return resB - resA;
        });

    // 独立した音声トラック
    const audioTracks = formats.filter(f => f.trackType === 'audio');
    
    const bestVideo = videoTracks[0] || null;
    const bestAudio = audioTracks[0] || null;

    const finalResponse = {
        success: true,
        videoId: resultVideoId,
        instance: instance,
        video: bestVideo, // 最高の動画トラック
        audio: bestAudio  // 最高の音声トラック
    };

    return res.status(200).json(finalResponse);
});
// ------------------------------------------

app.get('/', (req, res) => {
    res.status(200).send('Invidious Proxyは動いてるよ。動画データが欲しいなら /stream/:id (全フォーマット) または /high/:id (最高画質/音質の分離) を使ってね。');
});


app.listen(PORT, () => {
    console.log(`サーバーはポート${PORT}で起動したよ！`);
});

// AbortControllerのインポートがない場合は、ご自身の環境に合わせて追加してください。
// import { AbortController } from 'node-fetch';
