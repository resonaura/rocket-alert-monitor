import { TelegramClientService } from './telegram-client.service';
import { CallService } from './call.service';
import { AIAnalyzerService } from './ai-analyzer.service';
import { config } from '../config/settings';
import { Api } from 'telegram';

export class MonitorService {
    private telegramService: TelegramClientService;
    private callService: CallService;
    private aiAnalyzer: AIAnalyzerService;
    private checkInterval: number;
    private isAlerting: boolean = false;
    private monitorInterval: NodeJS.Timeout | null = null;

    constructor(telegramService: TelegramClientService) {
        this.telegramService = telegramService;
        this.callService = new CallService(telegramService);
        this.aiAnalyzer = new AIAnalyzerService();
        this.checkInterval = config.checkInterval;
    }

    public async startMonitoring(): Promise<void> {
        console.log('[Monitor] Запуск моніторингу...');
        console.log(`[Monitor] Перевірка кожні ${this.checkInterval / 1000} секунд`);

        // Перша перевірка одразу
        await this.checkForNewPosts();

        // Потім за розкладом
        this.monitorInterval = setInterval(async () => {
            if (!this.isAlerting) {
                await this.checkForNewPosts();
            } else {
                console.log('[Monitor] Пропускаємо перевірку - йде процес сповіщення');
            }
        }, this.checkInterval);

        console.log('[Monitor] Моніторинг запущено!');
    }

    public stopMonitoring(): void {
        if (this.monitorInterval) {
            clearInterval(this.monitorInterval);
            this.monitorInterval = null;
            console.log('[Monitor] Моніторинг зупинено');
        }
    }

    private async checkForNewPosts(): Promise<void> {
        try {
            console.log('[Monitor] Перевірка нових повідомлень...');
            const newMessages = await this.telegramService.getNewMessages();
            
            if (newMessages.length > 0) {
                console.log(`[Monitor] Знайдено нових повідомлень: ${newMessages.length}`);
                
                // Аналізуємо всі повідомлення через AI (пакетом)
                const analyses = await this.aiAnalyzer.analyzeMessages(newMessages);
                
                // Перевіряємо результати аналізу
                for (let i = 0; i < newMessages.length; i++) {
                    const message = newMessages[i];
                    const analysis = analyses[i];
                    
                    if (!analysis) continue;
                    
                    console.log(`[Monitor] 📊 Аналіз повідомлення ${i + 1}:`);
                    console.log(`  Рівень: ${analysis.threatLevel} (${analysis.confidence}%)`);
                    console.log(`  Причина: ${analysis.reason}`);
                    console.log(`  Текст: ${message.message?.substring(0, 100)}...`);
                    
                    // ЧЕРВОНИЙ КОД - телефонуємо негайно!
                    if (analysis.needCall) {
                        console.log(`[Monitor] 🚨🚨🚨 КРИТИЧНА ЗАГРОЗА! ТЕЛЕФОНУЄМО!`);
                        await this.alertUserWithCall(message, analysis);
                        break; // Обробляємо тільки першу критичну загрозу
                    }
                    
                    // ПОМАРАНЧЕВИЙ/ФІОЛЕТОВИЙ - відправляємо повідомлення
                    if (analysis.needMessage) {
                        console.log(`[Monitor] ⚠️  Виявлено загрозу. Відправляємо повідомлення.`);
                        await this.alertUserWithMessage(message, analysis);
                        // Продовжуємо перевіряти інші повідомлення
                    }
                }
            } else {
                console.log('[Monitor] Нових повідомлень немає');
            }
        } catch (error) {
            console.error('[Monitor] ❌ Помилка при перевірці повідомлень:', error);
        }
    }

    /**
     * Критична загроза - телефонуємо
     */
    private async alertUserWithCall(message: Api.Message, analysis: any): Promise<void> {
        this.isAlerting = true;
        console.log('[Monitor] 🚨 ЧЕРВОНИЙ КОД! Починаємо серію дзвінків...');
        console.log(`[Monitor] Причина: ${analysis.reason}`);

        try {
            // Спочатку відправляємо повідомлення з деталями
            const alertMessage = `🚨🚨🚨 КРИТИЧНА ЗАГРОЗА!\n\n` +
                `Рівень: ${this.getThreatLevelText(analysis.threatLevel)}\n` +
                `Місто: ${config.monitoredCity}\n` +
                `Впевненість: ${analysis.confidence}%\n\n` +
                `Причина: ${analysis.reason}\n\n` +
                `Повідомлення з каналу:\n${message.message || '[пусто]'}\n\n` +
                `⚠️ НЕГАЙНО В УКРИТТЯ!`;
            
            await this.telegramService.sendMessage(config.callUserId, alertMessage);
            
            // Потім телефонуємо
            await this.callService.makeCall();
            
            console.log('[Monitor] ✅ Процес сповіщення завершено');
        } catch (error) {
            console.error('[Monitor] ❌ Помилка при сповіщенні користувача:', error);
        } finally {
            this.isAlerting = false;
            console.log('[Monitor] Відновлюємо моніторинг...');
        }
    }

    /**
     * Середній рівень загрози - тільки повідомлення
     */
    private async alertUserWithMessage(message: Api.Message, analysis: any): Promise<void> {
        console.log('[Monitor] � Відправка попереджувального повідомлення...');

        try {
            const emoji = this.getThreatEmoji(analysis.threatLevel);
            const alertMessage = `${emoji} УВАГА: Потенційна загроза\n\n` +
                `Рівень: ${this.getThreatLevelText(analysis.threatLevel)}\n` +
                `Місто: ${config.monitoredCity}\n` +
                `Впевненість: ${analysis.confidence}%\n\n` +
                `Причина: ${analysis.reason}\n\n` +
                `Повідомлення з каналу:\n${message.message || '[пусто]'}\n\n` +
                `Стеж за оновленнями в каналі!`;
            
            await this.telegramService.sendMessage(config.callUserId, alertMessage);
            console.log('[Monitor] ✅ Попереджувальне повідомлення відправлено');
        } catch (error) {
            console.error('[Monitor] ❌ Помилка при відправці повідомлення:', error);
        }
    }

    private getThreatEmoji(level: string): string {
        switch (level) {
            case 'red': return '🟥';
            case 'orange': return '🟧';
            case 'purple': return '🟪';
            case 'yellow': return '🟨';
            default: return '🟩';
        }
    }

    private getThreatLevelText(level: string): string {
        switch (level) {
            case 'red': return '🟥 ЧЕРВОНИЙ (критична небезпека)';
            case 'orange': return '🟧 ПОМАРАНЧЕВИЙ (небезпечно)';
            case 'purple': return '🟪 ФІОЛЕТОВИЙ (балістична загроза)';
            case 'yellow': return '🟨 ЖОВТИЙ (відносно безпечно)';
            default: return '🟩 ЗЕЛЕНИЙ (безпечно)';
        }
    }
}
