import fetch from 'node-fetch';
import express from 'express';

const app = express();
const PORT = process.env.PORT || 3000;

// node-fetchがデフォルトでサポートしていないので、`agent`や`signal`を使わない場合は不要なことがあります
// が、fetchのタイムアウトを実装するためにtimeoutオプションをサポートするnode-fetchのバージョンが必要です。
// 依存関係によっては、AbortedControllerや外部ライブラリが必要になることがあります。

const videoCache = new Map();
const CACHE_DURATION_MS = 4 * 60 * 60 * 1000; // 4時間 (ミリ秒)

// ... (INVIDIOUS_INSTANCES と TARGET_ITAGS は変更なし)

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

// 取得したいitagのリスト。今回は全てを探すよ。
// itag '18' や '140' は音声を含むことがありますが、InvidiousのAPIからは分離したものが返ってくる可能性が高いです。
const TARGET_ITAGS = ['18','399','299','248','137','247','140','249','250','251'];

async function getAllTargetFormats(videoId) {
    for (const baseUrl of INVIDIOUS_INSTANCES) {
        const apiUrl = `${baseUrl}/api/v1/videos/${videoId}`;
        const foundFormats = [];

        try {
            console.log(`[${videoId}] インスタンス試すよ: ${baseUrl}`);
            
            // タイムアウト設定
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 7000); 

            const response = await fetch(apiUrl, { signal: controller.signal });
            clearTimeout(timeoutId); // 成功したらタイマーをクリア

            if (!response.ok) {
                console.warn(`[${videoId}] ${baseUrl}から${response.status}って返ってきたわ。次行くね`);
                continue;
            }

            const data = await response.json();
            
            if (data && data.videoId === videoId) {
                
                // adaptiveFormats (音声なし、動画なしのどちらか) と formatStreams (音声あり動画) を結合
                const allFormats = [
                    ...(data.adaptiveFormats || []), 
                    ...(data.formatStreams || [])
                ];

                // 全てのターゲットitagをチェック
                for (const targetItag of TARGET_ITAGS) {
                    const format = allFormats.find(f => f.itag === targetItag);
                    
                    if (format) {
                        // formatStreamsとadaptiveFormatsのプロパティの違いを吸収してデータを整形
                        // adaptiveFormatsにのみ存在するプロパティで、それが動画トラックか音声トラックか判断する
                        // 例: audioQuality や audioSampleRate がある => 音声トラック (audioIncluded: false のものも含む)
                        // 例: qualityLabel や resolution がある => 動画トラック
                        
                        const isAudioOnly = !!format.audioQuality; // InvidiousのAPIではオーディオのみのフォーマットにaudioQualityがあることが多い
                        const isVideoOnly = !!format.qualityLabel && !format.audioQuality; // 動画のみのフォーマット
                        const isCombined = !isAudioOnly && !!format.audioQuality && !!format.qualityLabel; // 動画+音声の結合フォーマット (itag:18など)
                        
                        foundFormats.push({
                            videoUrl: format.url,
                            itag: format.itag,
                            qualityLabel: format.qualityLabel || format.quality,
                            resolution: format.resolution,
                            container: format.container,
                            encoding: format.encoding,
                            // isAudioOnly: 独立した音声トラック
                            // isVideoOnly: 独立した動画トラック
                            // isCombined: 結合されたトラック (itag 18など)
                            trackType: isAudioOnly ? 'audio' : (isVideoOnly ? 'video' : 'combined')
                        });
                    }
                }
                
                // 目的のフォーマットが1つでも見つかったら、このインスタンスの結果を採用して終了
                if (foundFormats.length > 0) {
                    console.log(`[${videoId}] やった！${baseUrl}でitag ${foundFormats.map(f => f.itag).join(', ')}を見つけたよ`);
                    return {
                        success: true,
                        videoId: videoId,
                        instance: baseUrl,
                        formats: foundFormats
                    };
                } else {
                    console.log(`[${videoId}] ${baseUrl}には目的のitag(${TARGET_ITAGS.join(', ')})が無かったわ。次行くわ`);
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

// 既存の /stream/:id エンドポイント (変更なし)
app.get('/stream/:id', async (req, res) => {
    const videoId = req.params.id;

    if (!videoId) {
        return res.status(400).json({ 
            error: 'videoIdが必要だよ。/stream/:id の形式でリクエストしてね。' 
        });
    }

    const cachedItem = videoCache.get(videoId);
    
    if (cachedItem && cachedItem.expiry > Date.now()) {
        console.log(`[${videoId}] キャッシュヒット！4時間以内だから即返すわ`);
        return res.status(200).json(cachedItem.data);
    }

    const result = await getAllTargetFormats(videoId);

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

// ⭐ 新しく追加された /high/:id エンドポイント
app.get('/high/:id', async (req, res) => {
    const videoId = req.params.id;

    if (!videoId) {
        return res.status(400).json({ 
            error: 'videoIdが必要だよ。/high/:id の形式でリクエストしてね。' 
        });
    }

    // キャッシュキーを分ける (あるいは流用する)
    const cachedItem = videoCache.get(videoId); 
    
    // /stream と /high でキャッシュを共有する場合
    if (cachedItem && cachedItem.expiry > Date.now()) {
        console.log(`[${videoId}] キャッシュヒット！4時間以内だから即返すわ`);
        // キャッシュデータを使って、今回の要望の形式に変換
        const { success, videoId: cachedVideoId, instance, formats } = cachedItem.data;

        const videoTracks = formats.filter(f => f.trackType === 'video').sort((a, b) => {
            // resolutionに基づいて降順でソート（最高画質を最初に）
            const resA = parseInt((a.resolution || '0x0').split('x')[1]);
            const resB = parseInt((b.resolution || '0x0').split('x')[1]);
            return resB - resA;
        });

        const audioTracks = formats.filter(f => f.trackType === 'audio' || f.trackType === 'combined');
        
        // 最高の動画と最高の音声 (または結合トラック) を選ぶ
        const bestVideo = videoTracks[0] || null;
        const bestAudio = audioTracks[0] || null;

        // 結合トラック (itag:18など) が見つかった場合はそれを優先
        const combinedTrack = formats.find(f => f.trackType === 'combined');

        const finalResponse = {
            success: true,
            videoId: cachedVideoId,
            instance: instance,
            video: bestVideo, // 最高の動画トラック
            audio: bestAudio, // 最高の音声トラック
            combined: combinedTrack // 結合トラックがあれば
        };

        return res.status(200).json(finalResponse);
    }

    // キャッシュがない場合は取得
    const result = await getAllTargetFormats(videoId);

    if (result) {
        // キャッシュに保存 (オリジナルデータ)
        videoCache.set(videoId, {
            data: result,
            expiry: Date.now() + CACHE_DURATION_MS
        });
        console.log(`[${videoId}] 新しい結果をキャッシュに保存したよ。4時間有効ね`);

        // 取得した結果をフィルタリングして整理
        const { success, videoId: resultVideoId, instance, formats } = result;
        
        const videoTracks = formats.filter(f => f.trackType === 'video').sort((a, b) => {
            // resolutionに基づいて降順でソート（最高画質を最初に）
            const resA = parseInt((a.resolution || '0x0').split('x')[1]);
            const resB = parseInt((b.resolution || '0x0').split('x')[1]);
            return resB - resA;
        });

        const audioTracks = formats.filter(f => f.trackType === 'audio' || f.trackType === 'combined');
        
        // 最高の動画と最高の音声 (または結合トラック) を選ぶ
        const bestVideo = videoTracks[0] || null;
        const bestAudio = audioTracks[0] || null;

        // 結合トラック (itag:18など) が見つかった場合はそれを優先
        const combinedTrack = formats.find(f => f.trackType === 'combined');

        const finalResponse = {
            success: true,
            videoId: resultVideoId,
            instance: instance,
            video: bestVideo, // 最高の動画トラック
            audio: bestAudio, // 最高の音声トラック
            combined: combinedTrack // 結合トラックがあれば
        };

        return res.status(200).json(finalResponse);

    } else {
        return res.status(404).json({ 
            success: false, 
            error: `動画ID ${videoId} のストリームはどこにも無かったよ。` 
        });
    }
});
// ------------------------------------------

app.get('/', (req, res) => {
    res.status(200).send('Invidious Proxyは動いてるよ。動画データが欲しいなら /stream/:id または /high/:id を使ってね。');
});


app.listen(PORT, () => {
    console.log(`サーバーはポート${PORT}で起動したよ！`);
});

// AbortControllerのインポートがないため、もしエラーが出る場合は追加してください。
// import { AbortController } from 'node-fetch'; // または 'abort-controller'
