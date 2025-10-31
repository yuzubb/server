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

// /stream/ で使用: 18 は getAllTargetFormats 内で特別に優先されるため、リストから除外する
const TARGET_ITAGS_ALL_OTHER = [
    '22', '248', '271', '313', '315', '272',  // 動画 (複合と分離)
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
// getAllTargetFormats 関数
// ----------------------------------------------------
async function getAllTargetFormats(videoId, targetItags) {
    
    // /stream/ のリクエストでのみ '18' を最優先するフラグ
    // TARGET_ITAGS_ALL_OTHER が渡された場合、'18' を特別に優先する
    const prioritizeItag18 = targetItags === TARGET_ITAGS_ALL_OTHER; 
    
    // 検索するタグのリストを作成 (優先処理用)
    let searchItags = prioritizeItag18 ? targetItags : targetItags;

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

                // ⭐ /stream/ 優先処理 1: '18' が見つかったら即座にそれを返す
                if (prioritizeItag18) {
                    const itag18Format = allFormats.find(f => f.itag === '18');
                    if (itag18Format) {
                         const isCombined = itag18Format.itag === '18';
                        foundFormats.push({
                            videoUrl: itag18Format.url,
                            itag: itag18Format.itag,
                            qualityLabel: itag18Format.qualityLabel || itag18Format.quality,
                            resolution: itag18Format.resolution,
                            container: itag18Format.container,
                            encoding: itag18Format.encoding,
                            trackType: isCombined ? 'combined' : 'unknown'
                        });
                        console.log(`[${videoId}] やった！${baseUrl}で最優先itag '18' を見つけたよ`);
                        return {
                            success: true,
                            videoId: videoId,
                            instance: baseUrl,
                            formats: foundFormats
                        };
                    }
                }
                
                // ⭐ 優先処理 2: '18' が見つからなかった場合、または /high/ の場合は残りのタグを探す
                const tagsToSearch = prioritizeItag18 ? searchItags : targetItags;
                
                for (const targetItag of tagsToSearch) { 
                    const format = allFormats.find(f => f.itag === targetItag);
                    
                    if (format) {
                        
                        const isAudioOnly = !!format.audioQuality;
                        const isVideoOnly = !!format.qualityLabel && !format.audioQuality;
                        const isCombined = format.itag === '22';
                        
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
                    // /high/ の場合に備え、itag 18, 22 の複合トラックをここで探しておく (再試行用)
                    if (!prioritizeItag18) {
                        const fallbackFormats = [];
                        const fallbackItags = ['22', '18'];
                        for (const itag of fallbackItags) {
                            const format = allFormats.find(f => f.itag === itag);
                            if (format) {
                                fallbackFormats.push({
                                    videoUrl: format.url,
                                    itag: format.itag,
                                    qualityLabel: format.qualityLabel || format.quality,
                                    resolution: format.resolution,
                                    container: format.container,
                                    encoding: format.encoding,
                                    trackType: 'combined'
                                });
                            }
                        }
                        if (fallbackFormats.length > 0) {
                            // 複合トラックがあれば、それをformatsとして返す
                            return {
                                success: true,
                                videoId: videoId,
                                instance: baseUrl,
                                formats: fallbackFormats
                            };
                        }
                    }

                    console.log(`[${videoId}] ${baseUrl}には目的のitagが無かったわ。次行くわ`);
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
// /stream/:id エンドポイント
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
    
    if (cachedItem && cachedItem.expiry > Date.now()) {
        console.log(`[${videoId}] キャッシュヒット！4時間以内だから即返すわ`);
        result = cachedItem.data;
    } else {
        // TARGET_ITAGS_ALL_OTHER を渡し、関数内で '18' を最優先させる
        result = await getAllTargetFormats(videoId, TARGET_ITAGS_ALL_OTHER);
        
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

    return res.status(200).json(result);
});

// ----------------------------------------------------
// ⭐ 修正点: /high/:id エンドポイント (代替ロジックを追加)
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
    
    // 1. キャッシュチェック
    if (cachedItem && cachedItem.expiry > Date.now()) {
        console.log(`[${videoId}] キャッシュヒット！処理を続行するわ`);
        result = cachedItem.data; 
    } else {
        // 2. キャッシュがない、または期限切れの場合はデータ取得
        // TARGET_ITAGS_HIGH を渡す (分離トラックを探す)
        result = await getAllTargetFormats(videoId, TARGET_ITAGS_HIGH);
        
        if (result) {
            videoCache.set(videoId, {
                data: result,
                expiry: Date.now() + CACHE_DURATION_MS
            });
            console.log(`[${videoId}] 新しい結果をキャッシュに保存したよ。4時間有効ね`);
        } else {
            // ⭐ 分離トラックが見つからなかった場合、エラーを返さずに終了 (getAllTargetFormats内で複合トラックが見つかっている可能性があるため)
            console.log(`[${videoId}] TARGET_ITAGS_HIGH で分離トラックは見つかりませんでしたが、他の形式をチェックします。`);
        }
    }

    // 3. 結果をフィルタリングして厳選
    const dataToProcess = result || cachedItem?.data;

    if (!dataToProcess) {
        return res.status(404).json({ 
            success: false, 
            error: `動画ID ${videoId} のストリームはどこにも無かったよ。` 
        });
    }

    const { success, videoId: resultVideoId, instance, formats } = dataToProcess;
    
    // 分離トラック (Video/Audio) の厳選
    const videoTracks = formats
        .filter(f => f.trackType === 'video')
        .sort((a, b) => {
            const resA = parseInt((a.resolution || '0x0').split('x')[1]);
            const resB = parseInt((b.resolution || '0x0').split('x')[1]);
            if (resA === resB) {
                return parseInt(b.itag) - parseInt(a.itag);
            }
            return resB - resA;
        });

    const audioTracks = formats
        .filter(f => f.trackType === 'audio')
        .sort((a, b) => {
            return parseInt(b.itag) - parseInt(a.itag);
        });
    
    const bestVideo = videoTracks[0] || null;
    const bestAudio = audioTracks[0] || null;

    // 4. 分離トラックのペアが見つかったかどうかのチェック
    if (bestVideo && bestAudio) {
        // 分離トラックが見つかった場合
        const finalResponse = {
            success: true,
            videoId: resultVideoId,
            instance: instance,
            message: "最高画質と最高音質のトラックを1つずつ厳選しました。これらを結合して再生してください。",
            video: bestVideo, // 最高の動画トラック (厳選1つ)
            audio: bestAudio  // 最高の音声トラック (厳選1つ)
        };
        return res.status(200).json(finalResponse);
    } 
    
    // ⭐ 5. 分離トラックのペアが見つからなかった場合の代替処理
    console.warn(`[${videoId}] 分離トラックのペアが見つかりませんでした。複合トラックを探します。`);
    
    const combinedTrack = formats
        .filter(f => f.trackType === 'combined')
        .sort((a, b) => {
            // 複合トラックは 22 (720p) > 18 (360p) の順で優先
            return parseInt(b.itag) - parseInt(a.itag); 
        })[0] || null;

    if (combinedTrack) {
        // 複合トラックが見つかった場合、それを代替として返す
        const finalResponse = {
            success: true,
            videoId: resultVideoId,
            instance: instance,
            message: "分離トラックが見つからなかったため、代替として最も高画質な複合トラックを返します。",
            combined: combinedTrack
        };
        return res.status(200).json(finalResponse);
    }
    
    // 6. 複合トラックも見つからなかった場合、最終的なエラーを返す
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
    res.status(200).send('Invidious Proxyは動いてるよ。動画データが欲しいなら /stream/:id (全フォーマット) または /high/:id (最高画質/音質の分離を厳選) を使ってね。');
});


app.listen(PORT, () => {
    console.log(`サーバーはポート${PORT}で起動したよ！`);
});
