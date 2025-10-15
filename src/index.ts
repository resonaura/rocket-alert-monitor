import { config, validateConfig } from './config/settings';
import { TelegramClientService } from './services/telegram-client.service';
import { MonitorService } from './services/monitor.service';
import { Storage } from './utils/storage';

console.log('='.repeat(60));
console.log('🚨 ROCKET ALERT MONITOR 🚨');
console.log('Система моніторингу ракетних атак');
console.log('='.repeat(60));
console.log('');

async function main() {
    try {
        // Валідація конфігурації
        console.log('[Main] Перевірка конфігурації...');
        validateConfig();
        console.log('');

        // Ініціалізація Storage
        console.log('[Main] Ініціалізація сховища...');
        await Storage.init();
        console.log('');

        // Підключення до Telegram
        console.log('[Main] Ініціалізація Telegram клієнта...');
        const telegramService = new TelegramClientService();
        await telegramService.connect();
        console.log('');

        // Запуск моніторингу
        console.log('[Main] Ініціалізація системи моніторингу...');
        const monitorService = new MonitorService(telegramService);
        await monitorService.startMonitoring();
        console.log('');

        console.log('='.repeat(60));
        console.log('✅ Система успішно запущена та працює!');
        console.log('='.repeat(60));
        console.log('');

        // Обробка завершення процесу
        const shutdown = async (signal: string) => {
            console.log('');
            console.log(`[Main] Отримано сигнал ${signal}, завершення роботи...`);
            
            monitorService.stopMonitoring();
            await telegramService.disconnect();
            
            console.log('[Main] Систему зупинено');
            process.exit(0);
        };

        process.on('SIGINT', () => shutdown('SIGINT'));
        process.on('SIGTERM', () => shutdown('SIGTERM'));

    } catch (error) {
        console.error('');
        console.error('❌ КРИТИЧНА ПОМИЛКА ПРИ ЗАПУСКУ:');
        console.error(error);
        console.error('');
        process.exit(1);
    }
}

// Запуск додатку
main().catch((error) => {
    console.error('Необроблена помилка:', error);
    process.exit(1);
});