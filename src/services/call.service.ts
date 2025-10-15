import { TelegramClientService } from './telegram-client.service';
import { config } from '../config/settings';

export class CallService {
    private telegramService: TelegramClientService;

    constructor(telegramService: TelegramClientService) {
        this.telegramService = telegramService;
    }

    public async makeCall(): Promise<void> {
        console.log(`[CallService] 📞 Починаємо серію дзвінків користувачу ${config.callUserId}`);
        
        for (let attempt = 1; attempt <= config.callMaxRetries; attempt++) {
            console.log(`[CallService] Спроба ${attempt} з ${config.callMaxRetries}...`);
            
            const callSuccessful = await this.initiateCall();
            
            if (callSuccessful) {
                console.log('[CallService] ✅ Дзвінок прийнято!');
                return;
            }
            
            if (attempt < config.callMaxRetries) {
                console.log(`[CallService] Дзвінок не прийнято. Чекаємо ${config.callRetryInterval / 1000} секунд перед наступною спробою...`);
                await this.waitForResponse();
            }
        }
        
        // Якщо всі спроби невдалі - відправляємо повідомлення
        console.log('[CallService] ❌ Усі спроби дзвінків вичерпано');
        await this.sendFailureMessage();
    }

    private async initiateCall(): Promise<boolean> {
        try {
            const result = await this.telegramService.makeCall(config.callUserId);
            
            if (!result.success) {
                console.log('[CallService] ❌ Не вдалося ініціювати дзвінок');
                return false;
            }
            
            // Якщо дзвінок вже прийнято - відмінно!
            if (result.answered) {
                console.log('[CallService] ✅ Користувач відповів на дзвінок!');
                return true;
            }
            
            // Інакше чекаємо відповіді
            console.log(`[CallService] ⏳ Очікування відповіді (${config.callTimeout / 1000} секунд)...`);
            
            // Чекаємо вказаний час на відповідь
            await this.delay(config.callTimeout);
            
            // Після очікування перевіряємо ще раз (в реальності API може оновити статус)
            // Але для простоти вважаємо що якщо не відповів одразу - значить не прийняв
            console.log('[CallService] ⏱️ Час очікування вичерпано, дзвінок не прийнято');
            return false;
            
        } catch (error) {
            console.error('[CallService] Помилка при ініціації дзвінка:', error);
            return false;
        }
    }

    private waitForResponse(): Promise<void> {
        return new Promise(resolve => setTimeout(resolve, config.callRetryInterval));
    }

    private delay(ms: number): Promise<void> {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    private async sendFailureMessage(): Promise<void> {
        const message = '🚨 ТРЕВОГА! Ми намагалися тебе розбудити дзвінками, але не вийшло. Перевір канал сповіщень про ракетну небезпеку!';
        
        try {
            await this.telegramService.sendMessage(config.callUserId, message);
            console.log('[CallService] 📧 Повідомлення про невдалі спроби відправлено');
        } catch (error) {
            console.error('[CallService] Помилка при відправці повідомлення:', error);
        }
    }
}