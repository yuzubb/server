import fetch from 'node-fetch';
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
export default async function handler(req, res) {
    const videoId = req.query.id;

    if (!videoId) {
        return res.status(400).json({ error: '/high/:id の形式でリクエストしてください。' });
    }

    const TARGET_ITAGS = ['303', '299']; 

    for (const baseUrl of INVIDIOUS_INSTANCES) {
        const apiUrl = `${baseUrl}/api/v1/videos/${videoId}`;

        try {
            console.log(`Trying instance: ${apiUrl}`);
            
            const response = await fetch(apiUrl, { timeout: 5000 }); 

            if (!response.ok) {
                console.warn(`Instance ${baseUrl} returned status ${response.status}`);
                continue;
            }

            const data = await response.json();
            
            if (data && data.videoId === videoId) {
                
                const targetFormat = data.adaptiveFormats.find(format => 
                    TARGET_ITAGS.includes(format.itag)
                );

                if (targetFormat) {
                    console.log(`Found itag ${targetFormat.itag} from ${baseUrl}`);
                    return res.status(200).json({
                        success: true,
                        videoId: videoId,
                        instance: baseUrl,
                        videoUrl: targetFormat.url,
                        itag: targetFormat.itag,
                        qualityLabel: targetFormat.qualityLabel,
                        resolution: targetFormat.resolution,
                    });
                } else {
                    console.log(`${baseUrl} このインスタンスには必要なitagがなかったっぽい(⁠ ⁠；⁠∀⁠；⁠)). よっしゃ次実行するか！`);
            }

            } else {
                console.warn(`このインスタンスが不正なデータを送信したよ ${baseUrl} た、多分ね💦`);
            }

        } catch (error) {
            console.error(`このインスタンスだめだね ${baseUrl}:`, error.message);
        }
    }

    return res.status(404).json({ 
        success: false, 
        error: `えらー` 
    });
}
