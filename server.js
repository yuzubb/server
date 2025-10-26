import fetch from 'node-fetch';
import express from 'express';

const app = express();
const PORT = process.env.PORT || 3000;

// キャッシュ設定 (インメモリMapを使用)
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

const TARGET_ITAGS = ['18'];

async function getHighestQualityNoAudioUrl(videoId) {
    for (const baseUrl of INVIDIOUS_INSTANCES) {
        const apiUrl = `${baseUrl}/api/v1/videos/${videoId}`;

        try {
            console.log(`[${videoId}] インスタンス試すよ: ${baseUrl}`);
            
            const response = await fetch(apiUrl, { timeout: 7000 }); 

            if (!response.ok) {
                console.warn(`[${videoId}] ${baseUrl}から${response.status}って返ってきたわ。次行くね`);
                continue;
            }

            const data = await response.json();
            
            if (data && data.videoId === videoId && data.adaptiveFormats) {
                
                const targetFormat = data.adaptiveFormats
                    .filter(format => TARGET_ITAGS.includes(format.itag))
                    .sort((a, b) => {
                        const resA = parseInt(a.resolution?.replace('p', '')) || 0;
                        const resB = parseInt(b.resolution?.replace('p', '')) || 0;
                        return resB - resA;
                    })[0]; 

                if (targetFormat) {
                    console.log(`[${videoId}] やった！itag ${targetFormat.itag}を${baseUrl}で見つけたよ`);
                    return {
                        success: true,
                        videoId: videoId,
                        instance: baseUrl,
                        videoUrl: targetFormat.url,
                        itag: targetFormat.itag,
                        qualityLabel: targetFormat.qualityLabel,
                        resolution: targetFormat.resolution,
                        container: targetFormat.container,
                        encoding: targetFormat.encoding
                    };
                } else {
                    console.log(`[${videoId}] ${baseUrl}にはitagが無かったわ。次行くわ`);
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

app.get('/high/:id', async (req, res) => {
    const videoId = req.params.id;

    if (!videoId) {
        return res.status(400).json({ 
            error: 'videoIdが必要だよ。/high/:id の形式でリクエストしてね。' 
        });
    }

    const cachedItem = videoCache.get(videoId);
    
    if (cachedItem && cachedItem.expiry > Date.now()) {
        console.log(`[${videoId}] キャッシュヒット！4時間以内だから即返すわ`);
        return res.status(200).json(cachedItem.data);
    }

    const result = await getHighestQualityNoAudioUrl(videoId);

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
    res.status(200).send('Invidious Proxyは動いてるよ。動画データが欲しいなら /high/:id を使ってね。');
});


app.listen(PORT, () => {
    console.log(`サーバーはポート${PORT}で起動したよ！`);
});
