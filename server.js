import fetch from 'node-fetch';
import express from 'express';

const app = express();
const PORT = process.env.PORT || 3000;

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

const TARGET_ITAGS = ['303', '299'];

async function getHighestQualityNoAudioUrl(videoId) {
    for (const baseUrl of INVIDIOUS_INSTANCES) {
        const apiUrl = `${baseUrl}/api/v1/videos/${videoId}`;

        try {
            console.log(`[${videoId}] インスタンス試してみるよ: ${baseUrl}`);
            
            const response = await fetch(apiUrl, { timeout: 7000 }); 

            if (!response.ok) {
                console.warn(`[${videoId}] ${baseUrl} がステータス ${response.status} 返してきた。ダメだね。`);
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
                    console.log(`[${videoId}] ${baseUrl} から itag ${targetFormat.itag} 見つけたよ！`);
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
                    console.log(`[${videoId}] ${baseUrl} には目的のitagなかったわ。次いくよ。`);
                }
            } else {
                console.warn(`[${videoId}] ${baseUrl} のデータ、なんか変だよ。`);
            }

        } catch (error) {
            console.error(`[${videoId}] ${baseUrl} でエラー発生: ${error.message}`);
        }
    }

    return null;
}

app.get('/api/v1/videos/:id', async (req, res) => {
    const videoId = req.params.id;

    if (!videoId) {
        return res.status(400).json({ 
            error: 'videoIdが要るよ！/api/v1/videos/:id の形式でリクエストしてね。' 
        });
    }

    const result = await getHighestQualityNoAudioUrl(videoId);

    if (result) {
        return res.status(200).json(result);
    } else {
        return res.status(404).json({ 
            success: false, 
            error: `動画ID ${videoId} のストリーム、どれ探しても見つからなかったわ。` 
        });
    }
});

app.get('/', (req, res) => {
    res.status(200).send('Invidiousプロキシ動いてるよ。/api/v1/videos/:id を使って動画データを取得してね。');
});

app.listen(PORT, () => {
    console.log(`サーバー、ポート ${PORT} で聞いてるよ。`);
});
