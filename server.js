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

// /stream/ で使用: 18 は getAllTargetFormats 内で特別に優先されるため、リストから除外する
const TARGET_ITAGS_ALL_OTHER = [
    '22', '248', '271', '313', '315', '272',  // 動画 (複合と分離)
    '137', '299', '399', '264', '266',             // 動画 (分離)
    '251', '250', '249', '140', '141', '258'       // 音声
];

// /high/ で使用 (複合 18, 22 を含まない、高画質分離重視の全フォーマット)
// ⭐ 修正: 4K (313, 315, 266, 399) のitagを除外。最高で1440pまでを含むitagは残し、後続のフィルタで1080pに制限する。
// itag 248, 271, 137, 299, 264 は 1080p を含むため残す。
const TARGET_ITAGS_HIGH = [
    '248', '271', '272', // 動画のみ (VP9, 1080p, 1440p)
    '137', '299', '264', // 動画のみ (H.264, 1080p, 1440p)
    '251', '250', '249', '140', '141', '258'  // 音声のみ (Opus/AAC)
];

// ----------------------------------------------------
// getAllTargetFormats 関数
// ----------------------------------------------------
/**
 * Invidiousインスタンスを巡回し、指定されたitagのフォーマットを取得する。
 * /stream/からの呼び出しではitag '18'を最優先する。
 */
async function getAllTargetFormats(videoId, targetItags) {
    
    // /stream/ のリクエストでのみ '18' を最優先するフラグ
    const prioritizeItag18 = targetItags === TARGET_ITAGS_ALL_OTHER; 
    
    // 検索するタグのリスト
    let searchItags = prioritizeItag18 ? targetItags : targetItags;

    for (const baseUrl of INVIDIOUS_INSTANCES) {
        const apiUrl = `${baseUrl}/api/v1/videos/${videoId}`;
        const foundFormats = [];

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
                        const isCombined = format.itag === '22'; // itag 22は複合トラックとして特別に扱う
                        
                        foundFormats.push({
                            videoUrl: format.url,
                            itag: format.itag,
                            qualityLabel: format.qualityLabel || format.quality,
                            resolution: format.resolution,
                            container: format.container,
                            encoding: format.encoding,
                            // トラックタイプの判別
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
                    // /high/ の場合に備え、itag 18, 22 の複合トラックをここで探しておく (フォールバック用)
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

    // TARGET_ITAGS_ALL_OTHER を渡し、関数内で '18' を最優先させる
    const result = await getAllTargetFormats(videoId, TARGET_ITAGS_ALL_OTHER);
    
    if (result) {
        return res.status(200).json(result);
    } else {
        return res.status(404).json({ 
            success: false, 
            error: `動画ID ${videoId} のストリームはどこにも無かったよ。` 
        });
    }
});

// ----------------------------------------------------
// /high/:id エンドポイント
// ----------------------------------------------------
app.get('/high/:id', async (req, res) => {
    const videoId = req.params.id;

    if (!videoId) {
        return res.status(400).json({ 
            error: 'videoIdが必要だよ。/high/:id の形式でリクエストしてね。' 
        });
    }

    // TARGET_ITAGS_HIGH を渡す (分離トラックを探す。見つからなければ複合トラックがフォールバックとして返る可能性がある)
    const result = await getAllTargetFormats(videoId, TARGET_ITAGS_HIGH);
    
    if (!result) {
        // 分離トラックも複合トラックも全く見つからなかった場合
        return res.status(404).json({ 
            success: false, 
            error: `動画ID ${videoId} のストリームはどこにも無かったよ。` 
        });
    }

    // 取得した結果をフィルタリングして厳選
    const dataToProcess = result; 
    const { success, videoId: resultVideoId, instance, formats } = dataToProcess;
    
    // 1. 分離トラック (Video/Audio) の厳選
    const videoTracks = formats
        .filter(f => f.trackType === 'video')
        .filter(f => {
            // ⭐ 1080p制限フィルター: 縦解像度が1080ピクセル以下であることを確認
            const res = f.resolution || '0x0';
            const height = parseInt(res.split('x')[1]);
            return height <= 1080;
        })
        .sort((a, b) => {
            // 解像度の高いもの（1080pが最高）を優先的に選択
            const resA = parseInt((a.resolution || '0x0').split('x')[1]);
            const resB = parseInt((b.resolution || '0x0').split('x')[1]);
            if (resA === resB) {
                return parseInt(b.itag) - parseInt(a.itag); // 解像度が同じならitag（新しいコーデック）を優先
            }
            return resB - resA; // 解像度（例: 1080）を優先
        });

    const audioTracks = formats
        .filter(f => f.trackType === 'audio')
        .sort((a, b) => {
            // itagでソート（高品質な音声itagを優先）
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
            const res = f.resolution || '0x0';
            const height = parseInt(res.split('x')[1]);
            return height <= 1080;
        })
        .sort((a, b) => {
            // 複合トラックは 22 (720p) > 18 (360p) の順で優先
            return parseInt(b.itag) - parseInt(a.itag); 
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
