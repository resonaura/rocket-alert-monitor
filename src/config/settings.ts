import * as dotenv from 'dotenv';

dotenv.config();

export const config = {
    // Telegram API credentials
    apiId: parseInt(process.env.API_ID || '0'),
    apiHash: process.env.API_HASH || '',

    // Channel to monitor (может быть число или username)
    channelId: process.env.CHANNEL_ID || '-1001699010379',

    // User to call
    callUserId: parseInt(process.env.CALL_USER_ID || '0'),

    // City to monitor
    monitoredCity: process.env.MONITORED_CITY || 'Дніпро',

    // OpenRouter API key for AI analysis
    openRouterApiKey: process.env.OPENROUTER_API_KEY || '',

    // Keywords to search for (legacy, now using AI)
    keywords: (process.env.KEYWORDS || 'тривога,ракета,повітряна,Дніпро,Днепр,Днипро')
        .split(',')
        .map((k: string) => k.trim().toLowerCase()),

    // Call settings
    callMaxRetries: parseInt(process.env.CALL_MAX_RETRIES || '3'),
    callRetryInterval: parseInt(process.env.CALL_RETRY_INTERVAL || '120000'), // 2 minutes
    callTimeout: parseInt(process.env.CALL_TIMEOUT || '40000'), // 40 seconds

    // Check interval
    checkInterval: parseInt(process.env.CHECK_INTERVAL || '60000') // 1 minute
};

export function validateConfig(): void {
    if (!config.apiId || config.apiId === 0) {
        throw new Error('API_ID не встановлено в .env файлі');
    }
    if (!config.apiHash) {
        throw new Error('API_HASH не встановлено в .env файлі');
    }
    if (!config.callUserId || config.callUserId === 0) {
        throw new Error('CALL_USER_ID не встановлено в .env файлі');
    }
    if (!config.openRouterApiKey) {
        console.warn('[Config] ⚠️  OPENROUTER_API_KEY не встановлено - AI аналіз вимкнено, використовується простий пошук');
    }
    console.log('[Config] Конфігурацію успішно завантажено');
    console.log(`[Config] Моніторинг каналу: ${config.channelId}`);
    console.log(`[Config] Місто: ${config.monitoredCity}`);
    console.log(`[Config] AI аналіз: ${config.openRouterApiKey ? '✅ Увімкнено' : '❌ Вимкнено'}`);
    console.log(`[Config] Дзвінки користувачу: ${config.callUserId}`);
}