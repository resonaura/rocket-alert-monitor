import * as fs from 'fs';
import * as path from 'path';

interface StorageData {
    lastCheckedMessageId: number | null;
    processedMessageIds: Set<number>;
}

export class Storage {
    private static storageFile = path.join(process.cwd(), 'storage.json');
    private static data: StorageData = {
        lastCheckedMessageId: null,
        processedMessageIds: new Set<number>()
    };

    public static async init(): Promise<void> {
        try {
            if (fs.existsSync(this.storageFile)) {
                const fileContent = fs.readFileSync(this.storageFile, 'utf-8');
                const parsed = JSON.parse(fileContent);
                this.data.lastCheckedMessageId = parsed.lastCheckedMessageId || null;
                this.data.processedMessageIds = new Set(parsed.processedMessageIds || []);
                console.log('[Storage] Дані завантажено з storage.json');
            } else {
                console.log('[Storage] Файл storage.json не знайдено, створено новий');
                await this.save();
            }
        } catch (error) {
            console.error('[Storage] Помилка при ініціалізації:', error);
            this.data = {
                lastCheckedMessageId: null,
                processedMessageIds: new Set<number>()
            };
        }
    }

    public static getLastCheckedMessageId(): number | null {
        return this.data.lastCheckedMessageId;
    }

    public static setLastCheckedMessageId(messageId: number): void {
        this.data.lastCheckedMessageId = messageId;
        this.save();
    }

    public static isMessageProcessed(messageId: number): boolean {
        return this.data.processedMessageIds.has(messageId);
    }

    public static addProcessedMessage(messageId: number): void {
        this.data.processedMessageIds.add(messageId);
        
        // Зберігаємо тільки останні 1000 повідомлень для економії пам'яті
        if (this.data.processedMessageIds.size > 1000) {
            const sorted = Array.from(this.data.processedMessageIds).sort((a, b) => a - b);
            this.data.processedMessageIds = new Set(sorted.slice(-1000));
        }
        
        this.save();
    }

    private static save(): void {
        try {
            const dataToSave = {
                lastCheckedMessageId: this.data.lastCheckedMessageId,
                processedMessageIds: Array.from(this.data.processedMessageIds)
            };
            fs.writeFileSync(this.storageFile, JSON.stringify(dataToSave, null, 2), 'utf-8');
        } catch (error) {
            console.error('[Storage] Помилка при збереженні:', error);
        }
    }

    public static reset(): void {
        this.data = {
            lastCheckedMessageId: null,
            processedMessageIds: new Set<number>()
        };
        this.save();
        console.log('[Storage] Сховище очищено');
    }
}
