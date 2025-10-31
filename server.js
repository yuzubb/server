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

// 取得したいitagのリスト。今回は全てを探すよ。
const TARGET_ITAGS = ['18','399','299','248','137','247','140','249','250','251'];

async function getAllTargetFormats(videoId) {
    for (const baseUrl of INVIDIOUS_INSTANCES) {
        const apiUrl = `${baseUrl}/api/v1/videos/${videoId}`;
        const foundFormats = [];

        try {
            console.log(`[${videoId}] インスタンス試すよ: ${baseUrl}`);
            
            const response = await fetch(apiUrl, { timeout: 7000 }); 

            if (!response.ok) {
                console.warn(`[${videoId}] ${baseUrl}から${response.status}って返ってきたわ。次行くね`);
                continue;
            }

            const data = await response.json();
            
            if (data && data.videoId === videoId) {
                
                // adaptiveFormats (音声なし) と formatStreams (音声あり) を結合
                const allFormats = [
                    ...(data.adaptiveFormats || []), 
                    ...(data.formatStreams || [])
                ];

                // 全てのターゲットitagをチェック
                for (const targetItag of TARGET_ITAGS) {
                    const format = allFormats.find(f => f.itag === targetItag);
                    
                    if (format) {
                        // formatStreamsとadaptiveFormatsのプロパティの違いを吸収してデータを整形
                        const isAdaptive = (format.audioQuality || format.audioSampleRate);
                        
                        foundFormats.push({
                            videoUrl: format.url,
                            itag: format.itag,
                            qualityLabel: format.qualityLabel || format.quality,
                            resolution: format.resolution,
                            container: format.container,
                            encoding: format.encoding,
                            audioIncluded: !isAdaptive
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

app.get('/', (req, res) => {
    res.status(200).send('Invidious Proxyは動いてるよ。動画データが欲しいなら /stream/:id を使ってね。');
});


app.listen(PORT, () => {
    console.log(`サーバーはポート${PORT}で起動したよ！`);
});
