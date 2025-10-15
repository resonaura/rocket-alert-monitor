import { Logger, TelegramClient } from 'telegram';
import { StoreSession } from 'telegram/sessions';
import { Api } from 'telegram';
import { LogLevel } from 'telegram/extensions/Logger';
import { input } from '@inquirer/prompts';
import { config } from '../config/settings';
import { Storage } from '../utils/storage';
import * as crypto from 'crypto';

export class TelegramClientService {
    private client: TelegramClient;
    private isConnected: boolean = false;

    constructor() {
        const session = new StoreSession('.session');
        this.client = new TelegramClient(session, config.apiId, config.apiHash, {
            connectionRetries: 5,
            baseLogger: new Logger(LogLevel.WARN)
        });
    }

    public async connect(): Promise<void> {
        console.log('[Telegram] Підключення до Telegram...');
        
        await this.client.start({
            phoneNumber: async () => await input({ message: 'Введіть номер телефону: ' }),
            password: async () => await input({ message: 'Введіть пароль 2FA: ' }),
            phoneCode: async () => await input({ message: 'Введіть код з Telegram: ' }),
            onError: (err: Error) => console.error('[Telegram] Помилка авторизації:', err),
        });

        this.isConnected = true;
        console.log('[Telegram] Успішно підключено!');

        // Проверяем подписку на канал
        await this.ensureChannelSubscription();
    }

    private async ensureChannelSubscription(): Promise<void> {
        try {
            const channelEntity = await this.client.getEntity(config.channelId);
            
            // Проверяем статус подписки
            const result = await this.client.invoke(
                new Api.channels.GetParticipant({
                    channel: channelEntity,
                    participant: 'me'
                })
            );

            console.log('[Telegram] Вже підписані на канал');
        } catch (error: any) {
            // Если не подписаны - подписываемся
            if (error.errorMessage === 'USER_NOT_PARTICIPANT') {
                console.log('[Telegram] Підписуємося на канал...');
                try {
                    await this.client.invoke(
                        new Api.channels.JoinChannel({
                            channel: await this.client.getEntity(config.channelId)
                        })
                    );
                    console.log('[Telegram] Успішно підписалися на канал!');
                } catch (joinError) {
                    console.error('[Telegram] Помилка при підписці на канал:', joinError);
                }
            } else {
                console.error('[Telegram] Помилка при перевірці підписки:', error);
            }
        }
    }

    public async getNewMessages(): Promise<Api.Message[]> {
        if (!this.isConnected) {
            throw new Error('Telegram client is not connected');
        }

        try {
            const channel = await this.client.getEntity(config.channelId);
            const lastCheckedId = Storage.getLastCheckedMessageId();

            // Отримуємо останні повідомлення
            const messages = await this.client.getMessages(channel, {
                limit: 20,
                minId: lastCheckedId || undefined
            });

            const newMessages: Api.Message[] = [];
            
            for (const msg of messages) {
                if (msg instanceof Api.Message && msg.id) {
                    if (!lastCheckedId || msg.id > lastCheckedId) {
                        if (!Storage.isMessageProcessed(msg.id)) {
                            newMessages.push(msg);
                            Storage.addProcessedMessage(msg.id);
                        }
                    }
                    
                    // Оновлюємо останній перевірений ID
                    if (!lastCheckedId || msg.id > lastCheckedId) {
                        Storage.setLastCheckedMessageId(msg.id);
                    }
                }
            }

            return newMessages.reverse(); // Повертаємо в хронологічному порядку
        } catch (error) {
            console.error('[Telegram] Помилка при отриманні повідомлень:', error);
            return [];
        }
    }

    public async makeCall(userId: number): Promise<{ success: boolean; answered: boolean }> {
        try {
            console.log(`[Telegram] Телефонуємо користувачу ${userId}...`);
            
            const userEntity = await this.client.getEntity(userId);
            
            // Генеруємо випадковий ID для дзвінка (в межах signed int32)
            const randomId = Math.floor(Math.random() * 0x7FFFFFFF);
            
            // Створюємо g_a hash (SHA-256 від випадкових даних)
            const gA = crypto.randomBytes(256);
            const gAHash = crypto.createHash('sha256').update(gA).digest();
            
            // Використовуємо requestCall для дзвінка
            const result = await this.client.invoke(
                new Api.phone.RequestCall({
                    userId: userEntity,
                    randomId: randomId,
                    gAHash: gAHash,
                    protocol: new Api.PhoneCallProtocol({
                        minLayer: 65,
                        maxLayer: 92,
                        udpP2p: true,
                        udpReflector: true,
                        libraryVersions: []
                    })
                })
            );

            console.log('[Telegram] Дзвінок ініційовано, результат:', result.className);
            
            // Перевіряємо результат
            if (result instanceof Api.phone.PhoneCall) {
                const phoneCall = result.phoneCall;
                let callId: any;
                let accessHash: any;
                
                // Зберігаємо ID дзвінка для подальшої перевірки
                if (phoneCall instanceof Api.PhoneCallRequested || 
                    phoneCall instanceof Api.PhoneCallWaiting ||
                    phoneCall instanceof Api.PhoneCallAccepted) {
                    callId = phoneCall.id;
                    accessHash = phoneCall.accessHash;
                }
                
                // Перевіряємо статус дзвінка
                if (phoneCall instanceof Api.PhoneCallAccepted) {
                    console.log('[Telegram] ✅ Дзвінок прийнято користувачем!');
                    // Завершуємо дзвінок бо мета досягнута
                    await this.discardCall(callId, accessHash);
                    return { success: true, answered: true };
                } else if (phoneCall instanceof Api.PhoneCallRequested || 
                           phoneCall instanceof Api.PhoneCallWaiting) {
                    console.log('[Telegram] Дзвінок очікує відповіді...');
                    
                    const waitTime = config.callTimeout;
                    console.log(`[Telegram] Очікуємо ${waitTime / 1000} секунд...`);
                    
                    // Чекаємо на оновлення статусу дзвінка через updates
                    let callAnswered = false;
                    let callDiscarded = false;
                    
                    const updateHandler = (update: any) => {
                        if (update instanceof Api.UpdatePhoneCall) {
                            const phoneCall = update.phoneCall;
                            
                            if (phoneCall.id?.equals(callId)) {
                                if (phoneCall instanceof Api.PhoneCallAccepted) {
                                    console.log('[Telegram] 📞 Дзвінок прийнято!');
                                    callAnswered = true;
                                } else if (phoneCall instanceof Api.PhoneCallDiscarded) {
                                    console.log('[Telegram] 📵 Дзвінок завершено/відхилено');
                                    callDiscarded = true;
                                }
                            }
                        }
                    };
                    
                    // Підписуємося на оновлення
                    this.client.addEventHandler(updateHandler);
                    
                    // Чекаємо з періодичною перевіркою статусу
                    const startTime = Date.now();
                    while (Date.now() - startTime < waitTime && !callAnswered && !callDiscarded) {
                        await new Promise(resolve => setTimeout(resolve, 1000));
                    }
                    
                    const timeElapsed = Date.now() - startTime;
                    
                    // Завершуємо дзвінок якщо він ще активний
                    if (!callDiscarded) {
                        console.log('[Telegram] Завершуємо дзвінок...');
                        await this.discardCall(callId, accessHash);
                    }
                    
                    // Якщо дзвінок завершився раніше таймауту - користувач відповів/прокинувся
                    if (callAnswered || (callDiscarded && timeElapsed < waitTime)) {
                        console.log('[Telegram] ✅ Користувач відповів на дзвінок (прокинувся)!');
                        return { success: true, answered: true };
                    } else {
                        console.log('[Telegram] ❌ Користувач не відповів');
                        return { success: true, answered: false };
                    }
                } else if (phoneCall instanceof Api.PhoneCallDiscarded) {
                    console.log('[Telegram] ❌ Дзвінок відхилено або не прийнято');
                    return { success: true, answered: false };
                }
            }

            return { success: true, answered: false };
        } catch (error: any) {
            console.error('[Telegram] Помилка при дзвінку:', error.errorMessage || error);
            return { success: false, answered: false };
        }
    }

    private async discardCall(callId: any, accessHash: any): Promise<void> {
        try {
            await this.client.invoke(
                new Api.phone.DiscardCall({
                    peer: new Api.InputPhoneCall({
                        id: callId,
                        accessHash: accessHash
                    }),
                    duration: 1,
                    reason: new Api.PhoneCallDiscardReasonHangup(),
                    connectionId: 0 as any
                })
            );
            console.log('[Telegram] Дзвінок завершено');
        } catch (error) {
            console.error('[Telegram] Помилка при завершенні дзвінка:', error);
        }
    }

    public async sendMessage(userId: number, message: string): Promise<void> {
        try {
            console.log(`[Telegram] Відправка повідомлення користувачу ${userId}...`);
            
            await this.client.sendMessage(userId, { message });
            
            console.log('[Telegram] Повідомлення відправлено');
        } catch (error) {
            console.error('[Telegram] Помилка при відправці повідомлення:', error);
        }
    }

    public async disconnect(): Promise<void> {
        if (this.isConnected) {
            await this.client.disconnect();
            this.isConnected = false;
            console.log('[Telegram] Відключено від Telegram');
        }
    }

    public getClient(): TelegramClient {
        return this.client;
    }
}
