import { createOpenAI } from '@ai-sdk/openai';
import { generateObject } from 'ai';
import { z } from 'zod';
import { config } from '../config/settings';
import { Api } from 'telegram';

// Схема відповіді AI
const ThreatAnalysisSchema = z.object({
    needCall: z.boolean().describe('Чи потрібно негайно телефонувати (червоний код, критична небезпека)'),
    needMessage: z.boolean().describe('Чи потрібно відправити повідомлення (є ризики, але не критично)'),
    threatLevel: z.enum(['red', 'orange', 'purple', 'yellow', 'none']).describe('Рівень загрози'),
    confidence: z.number().min(0).max(100).describe('Впевненість в оцінці (0-100%)'),
    reason: z.string().describe('Коротке пояснення причини оцінки'),
    cityMentioned: z.boolean().describe('Чи згадується наше місто')
});

export type ThreatAnalysis = z.infer<typeof ThreatAnalysisSchema>;

export class AIAnalyzerService {
    private openai: ReturnType<typeof createOpenAI> | null = null;
    private isEnabled: boolean = false;

    constructor() {
        if (config.openaiApiKey) {
            this.openai = createOpenAI({
                apiKey: config.openaiApiKey,
            });
            this.isEnabled = true;
            console.log('[AI Analyzer] ✅ AI аналізатор ініціалізовано (модель: gpt-4o-mini)');
        } else {
            console.log('[AI Analyzer] ⚠️  AI аналізатор вимкнено (немає OPENAI_API_KEY)');
        }
    }

    /**
     * Аналізує пакет повідомлень з каналу
     */
    public async analyzeMessages(messages: Api.Message[]): Promise<ThreatAnalysis[]> {
        if (!this.isEnabled || !this.openai) {
            // Fallback на простий аналіз без AI
            return messages.map(msg => this.fallbackAnalysis(msg));
        }

        try {
            // Аналізуємо пакетом для економії
            const results: ThreatAnalysis[] = [];
            
            // Групуємо по 5 повідомлень для оптимізації
            const batchSize = 5;
            for (let i = 0; i < messages.length; i += batchSize) {
                const batch = messages.slice(i, i + batchSize);
                const batchResults = await this.analyzeBatch(batch);
                results.push(...batchResults);
            }

            return results;
        } catch (error) {
            console.error('[AI Analyzer] ❌ Помилка при аналізі, використовуємо fallback:', error);
            // При помилці повертаємо простий аналіз
            return messages.map(msg => this.fallbackAnalysis(msg));
        }
    }

    /**
     * Аналізує одне повідомлення (для сумісності)
     */
    public async analyzeMessage(message: Api.Message): Promise<ThreatAnalysis> {
        const results = await this.analyzeMessages([message]);
        return results[0];
    }

    /**
     * Аналізує пакет повідомлень через AI
     */
    private async analyzeBatch(messages: Api.Message[]): Promise<ThreatAnalysis[]> {
        if (!this.openai) {
            return messages.map(msg => this.fallbackAnalysis(msg));
        }

        try {
            const messagesText = messages.map((msg, idx) => 
                `Повідомлення ${idx + 1}:\n${msg.message || '[пусто]'}\n`
            ).join('\n---\n');

            const systemPrompt = `Ти експерт з аналізу повідомлень про повітряні тривоги в Україні.

ВАЖЛИВО: Нас цікавить ТІЛЬКИ місто "${config.monitoredCity}".

РІВНІ ЗАГРОЗИ:
🟥 ЧЕРВОНИЙ (red) - needCall=true
   - Критична небезпека для НАШОГО міста
   - Ракета/ціль за 5-10 хвилин від міста АБО вже над ним
   - Обов'язкове укриття
   - Приклади: "Дніпро червоний", "ракета над Дніпром", "КАБ по Дніпру"

🟧 ПОМАРАНЧЕВИЙ (orange) - needMessage=true
   - Є загроза, але до міста 10-20 хвилин
   - Або ціль рухається повз місто
   - Приклади: "Дніпро помаранчевий", "ракета йде на Дніпро"

🟪 ФІОЛЕТОВИЙ (purple) - needMessage=true  
   - Балістична загроза (ББ)
   - Може стати червоним
   - Приклади: "ББ в напрямку Дніпро"

🟨 ЖОВТИЙ (yellow) - needMessage=false
   - Малоймовірна загроза
   - Тривога є, але далеко від міста
   
🟩 НЕМАЄ ЗАГРОЗИ (none) - needMessage=false, needCall=false
   - Місто не згадується АБО
   - Відбій тривоги АБО
   - Інформація про інші міста

СКОРОЧЕННЯ:
- ББ = балістична балістика (балістичні ракети)
- ТТ = тактична тактика (авіація, КАБ)
- КАР/КАБ = керовані авіаційні ракети/бомби

ЛОГІКА:
1. Якщо НЕ згадується наше місто → none, needCall=false, needMessage=false
2. Якщо "червоний/красний" для нашого міста → red, needCall=true
3. Якщо "помаранчевий/оранжевий" для нашого міста → orange, needMessage=true
4. Якщо "фіолетовий/фиолетовый" або "ББ" для нашого міста → purple, needMessage=true
5. Якщо відбій/отбой → none, needCall=false, needMessage=false

Аналізуй КОЖНЕ повідомлення окремо і повертай масив результатів.`;

            const { object } = await generateObject({
                model: this.openai.chat('gpt-4o-mini'),
                schema: z.object({
                    analyses: z.array(ThreatAnalysisSchema)
                }),
                prompt: messagesText,
                system: systemPrompt,
                temperature: 0.3, // Низька температура для більш передбачуваних результатів
                maxTokens: 2000,
            });

            // Логуємо результати
            object.analyses.forEach((analysis, idx) => {
                const emoji = this.getThreatEmoji(analysis.threatLevel);
                console.log(`[AI Analyzer] ${emoji} Повідомлення ${idx + 1}: ${analysis.threatLevel} (${analysis.confidence}%) - ${analysis.reason}`);
            });

            return object.analyses;
        } catch (error: any) {
            console.error('[AI Analyzer] Помилка при аналізі батча:', error.message || error);
            // При помилці AI використовуємо fallback
            return messages.map(msg => this.fallbackAnalysis(msg));
        }
    }

    /**
     * Простий аналіз без AI (fallback)
     */
    private fallbackAnalysis(message: Api.Message): ThreatAnalysis {
        const text = (message.message || '').toLowerCase();
        const cityNormalized = config.monitoredCity.toLowerCase();
        
        // Варіанти написання міста
        const cityVariants = ['дніпро', 'днепр', 'днипро', 'дніпр', 'dnipro'];
        const cityMentioned = cityVariants.some(variant => text.includes(variant));

        if (!cityMentioned) {
            return {
                needCall: false,
                needMessage: false,
                threatLevel: 'none',
                confidence: 80,
                reason: 'Місто не згадується',
                cityMentioned: false
            };
        }

        // Перевіряємо рівень загрози
        if (text.includes('червон') || text.includes('красн') || 
            text.includes('критич') || text.includes('над город')) {
            return {
                needCall: true,
                needMessage: true,
                threatLevel: 'red',
                confidence: 70,
                reason: 'Червоний код для міста (простий аналіз)',
                cityMentioned: true
            };
        }

        if (text.includes('помаранчев') || text.includes('оранжев')) {
            return {
                needCall: false,
                needMessage: true,
                threatLevel: 'orange',
                confidence: 70,
                reason: 'Помаранчевий код для міста (простий аналіз)',
                cityMentioned: true
            };
        }

        if (text.includes('фіолетов') || text.includes('фиолетов') || 
            text.includes(' бб ') || text.includes('баліст')) {
            return {
                needCall: false,
                needMessage: true,
                threatLevel: 'purple',
                confidence: 70,
                reason: 'Фіолетовий код / ББ для міста (простий аналіз)',
                cityMentioned: true
            };
        }

        if (text.includes('відбій') || text.includes('отбой') || text.includes('скасов')) {
            return {
                needCall: false,
                needMessage: false,
                threatLevel: 'none',
                confidence: 80,
                reason: 'Відбій тривоги',
                cityMentioned: true
            };
        }

        // За замовчуванням - жовтий (місто згадується, але немає явної загрози)
        return {
            needCall: false,
            needMessage: false,
            threatLevel: 'yellow',
            confidence: 60,
            reason: 'Місто згадується, але загроза неясна (простий аналіз)',
            cityMentioned: true
        };
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
}
