import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { generateObject } from "ai";
import { z } from "zod";
import { config } from "../config/settings";
import { Api } from "telegram";

// Схема відповіді AI
const ThreatAnalysisSchema = z.object({
  needCall: z
    .boolean()
    .describe(
      "Чи потрібно негайно телефонувати (червоний код, критична небезпека)"
    ),
  needMessage: z
    .boolean()
    .describe(
      "Чи потрібно відправити повідомлення (є ризики, але не критично)"
    ),
  threatLevel: z
    .enum(["red", "orange", "purple", "yellow", "none"])
    .describe("Рівень загрози"),
  confidence: z
    .number()
    .min(0)
    .max(100)
    .describe("Впевненість в оцінці (0-100%)"),
  reason: z.string().describe("Коротке пояснення причини оцінки"),
  cityMentioned: z.boolean().describe("Чи згадується наше місто"),
});

export type ThreatAnalysis = z.infer<typeof ThreatAnalysisSchema>;

export class AIAnalyzerService {
  private openrouter: ReturnType<typeof createOpenRouter> | null = null;
  private isEnabled: boolean = false;

  constructor() {
    if (config.openRouterApiKey) {
      this.openrouter = createOpenRouter({
        apiKey: config.openRouterApiKey,
      });
      this.isEnabled = true;
      console.log(
        "[AI Analyzer] ✅ AI аналізатор ініціалізовано (модель: qwen/qwen3-vl-235b-a22b-instruct)"
      );
    } else {
      console.log(
        "[AI Analyzer] ⚠️  AI аналізатор вимкнено (немає OPENROUTER_API_KEY)"
      );
    }
  }

  /**
   * Аналізує пакет повідомлень з каналу
   */
  public async analyzeMessages(
    messages: Api.Message[]
  ): Promise<ThreatAnalysis[]> {
    if (!this.isEnabled || !this.openrouter) {
      // Fallback на простий аналіз без AI
      return messages.map((msg) => this.fallbackAnalysis(msg));
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
      console.error(
        "[AI Analyzer] ❌ Помилка при аналізі, використовуємо fallback:",
        error
      );
      // При помилці повертаємо простий аналіз
      return messages.map((msg) => this.fallbackAnalysis(msg));
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
  private async analyzeBatch(
    messages: Api.Message[]
  ): Promise<ThreatAnalysis[]> {
    if (!this.openrouter) {
      return messages.map((msg) => this.fallbackAnalysis(msg));
    }

    try {
      // КРИТИЧНО ВАЖЛИВО: Очищуємо повідомлення від футерів з лінками на інші канали
      // Це запобігає помилковому спрацюванню на інші міста (Павлоград, Київ тощо)
      const messagesText = messages
        .map((msg, idx) => {
          let text = msg.message || "[пусто]";

          // Видаляємо футер з лінками на канали, який зазвичай виглядає як:
          // [Дніпро Alerts 🚀 🚨] | [Київ Alerts 🚀 🚨] | [Alerts Live 🚀 🚨]
          // або
          // [Channel1] | [Channel2] | [Channel3]
          text = text.replace(
            /\[.*?Alerts.*?\](\s*\|\s*\[.*?Alerts.*?\])*/gi,
            ""
          );

          // Також видаляємо будь-які інші лінки каналів у квадратних дужках наприкінці
          text = text.replace(/(\[.*?\]\s*\|\s*)*\[.*?\]\s*$/gi, "");

          // Обрізаємо зайві пробіли
          text = text.trim();

          return `Повідомлення ${idx + 1}:\n${text}\n`;
        })
        .join("\n---\n");

      const systemPrompt = `Ти експерт з аналізу повідомлень про повітряні тривоги в Україні.

🎯 КРИТИЧНО ВАЖЛИВО: Нас цікавить ТІЛЬКИ місто "${config.monitoredCity}".

⚠️ ПРАВИЛО #1: ТОЧНА ПЕРЕВІРКА НАЗВИ МІСТА
- Повідомлення про "Павлоград" ≠ "Дніпро" - НЕ ПЛУТАЙ ЇХ НІКОЛИ!
- Повідомлення про "Кривий Ріг" ≠ "Дніпро" (навіть якщо в області)
- "Кам'янське" ≠ "Дніпро"
- "Нікополь" ≠ "Дніпро"
- Якщо в тексті є ІНША назва міста (не "${config.monitoredCity}") → завжди none, cityMentioned=false
- Загальні фрази "Дніпропетровська область" без конкретного міста → yellow
- ІГНОРУЙ будь-які згадки інших міст у футерах або посиланнях!

⚠️ ПРАВИЛО #2: ФУТЕРИ З ЛІНКАМИ - ІГНОРУЙ ЇХ!
- Якщо в кінці повідомлення є лінки типу [Павлоград Alerts] | [Київ Alerts] - це просто лінки!
- ЦІ ЛІНКИ НЕ ОЗНАЧАЮТЬ, що є загроза для цих міст
- Аналізуй ТІЛЬКИ основний текст повідомлення, НЕ футер з лінками
- Якщо основний текст НЕ містить назви нашого міста - none, навіть якщо є лінки

РІВНІ ЗАГРОЗИ:
🟥 ЧЕРВОНИЙ (red) - needCall=true, needMessage=false
   - Критична небезпека ТІЛЬКИ для "${config.monitoredCity}"
   - Ракета/ціль за 5-10 хвилин від міста АБО вже над ним
   - Обов'язкове укриття
   - Приклади: "${config.monitoredCity} червоний", "ракета над ${config.monitoredCity}", "КАБ по ${config.monitoredCity}"

🟧 ПОМАРАНЧЕВИЙ (orange) - needMessage=true, needCall=false
   - Є загроза для "${config.monitoredCity}", але до міста 10-20 хвилин
   - Або ціль рухається повз місто
   - Приклади: "${config.monitoredCity} помаранчевий", "ракета йде на ${config.monitoredCity}"

🟪 ФІОЛЕТОВИЙ (purple) - needMessage=true, needCall=false
   - Балістична загроза (ББ) для "${config.monitoredCity}"
   - Може стати червоним
   - Приклади: "ББ в напрямку ${config.monitoredCity}"

🟨 ЖОВТИЙ (yellow) - needMessage=false, needCall=false
   - Малоймовірна загроза
   - Тривога є, але далеко від міста
   - Або загальна інформація про область
   
🟩 НЕМАЄ ЗАГРОЗИ (none) - needMessage=false, needCall=false
   - "${config.monitoredCity}" НЕ згадується АБО
   - Згадується ІНШЕ місто (Павлоград, Кривий Ріг, Київ тощо) АБО
   - Відбій тривоги АБО
   - Інформація про інші регіони АБО
   - Тільки футер з лінками, без реальної загрози для нашого міста

СКОРОЧЕННЯ:
- ББ = балістична балістика (балістичні ракети)
- ТТ = тактична тактика (авіація, КАБ)
- КАР/КАБ = керовані авіаційні ракети/бомби

ЛОГІКА АНАЛІЗУ:
1. ВИДАЛИ З РОЗГЛЯДУ футер з лінками на канали (якщо є)
2. Перевір чи згадується ТОЧНА назва "${config.monitoredCity}" (або Дніпропетровськ якщо Дніпро) В ОСНОВНОМУ ТЕКСТІ
3. Якщо згадується ІНШЕ місто (Павлоград, Кривий Ріг, Київ) → завжди none, cityMentioned=false
4. Якщо наше місто + "червоний/красний" → red, needCall=true
5. Якщо наше місто + "помаранчевий/оранжевий" → orange, needMessage=true
6. Якщо наше місто + "фіолетовий/фиолетовый" або "ББ" → purple, needMessage=true
7. Якщо відбій для нашого міста → none
8. Якщо ТІЛЬКИ область без міста → yellow

Аналізуй КОЖНЕ повідомлення окремо і повертай масив результатів.`;

      // Avoid deep TypeScript instantiation errors by casting generateObject and schema to any,
      // then assert the returned object shape to ThreatAnalysis[] for downstream usage.
      const { object } = (await (generateObject as any)({
        model: this.openrouter.chat("openai/gpt-4o-mini"),
        schema: z.object({
          analyses: z.array(ThreatAnalysisSchema),
        }) as any,
        prompt: messagesText,
        system: systemPrompt,
        temperature: 0.1, // Дуже низька температура для максимальної точності та передбачуваності
        maxTokens: 3000,
      })) as { object: { analyses: ThreatAnalysis[] } };

      // Логуємо результати
      object.analyses.forEach((analysis, idx) => {
        const emoji = this.getThreatEmoji(analysis.threatLevel);
        console.log(
          `[AI Analyzer] ${emoji} Повідомлення ${idx + 1}: ${
            analysis.threatLevel
          } (${analysis.confidence}%) - ${analysis.reason}`
        );
      });

      return object.analyses;
    } catch (error: any) {
      console.error(
        "[AI Analyzer] Помилка при аналізі батча:",
        error.message || error
      );
      // При помилці AI використовуємо fallback
      return messages.map((msg) => this.fallbackAnalysis(msg));
    }
  }

  /**
   * Простий аналіз без AI (fallback)
   */
  private fallbackAnalysis(message: Api.Message): ThreatAnalysis {
    let text = (message.message || "").toLowerCase();

    // Видаляємо футер з лінками на канали (так само як у AI аналізі)
    text = text.replace(/\[.*?alerts.*?\](\s*\|\s*\[.*?alerts.*?\])*/gi, "");
    text = text.replace(/(\[.*?\]\s*\|\s*)*\[.*?\]\s*$/gi, "");
    text = text.trim();

    const cityNormalized = config.monitoredCity.toLowerCase();

    // Варіанти написання міста
    const cityVariants = ["дніпро", "днепр", "днипро", "дніпр", "dnipro"];
    const cityMentioned = cityVariants.some((variant) =>
      text.includes(variant)
    );

    // Перевіряємо чи не згадуються інші міста (які не є нашим містом)
    const otherCities = [
      "павлоград",
      "павлоград",
      "кривий ріг",
      "кривой рог",
      "київ",
      "киев",
      "кам'янське",
      "каменское",
      "нікополь",
      "никополь",
    ];
    const otherCityMentioned = otherCities.some((city) => text.includes(city));

    // Якщо згадується інше місто - ігноруємо
    if (otherCityMentioned && !cityMentioned) {
      return {
        needCall: false,
        needMessage: false,
        threatLevel: "none",
        confidence: 85,
        reason: "Згадується інше місто (не наше)",
        cityMentioned: false,
      };
    }

    if (!cityMentioned) {
      return {
        needCall: false,
        needMessage: false,
        threatLevel: "none",
        confidence: 80,
        reason: "Місто не згадується",
        cityMentioned: false,
      };
    }

    // Перевіряємо рівень загрози
    if (
      text.includes("червон") ||
      text.includes("красн") ||
      text.includes("критич") ||
      text.includes("над город")
    ) {
      return {
        needCall: true,
        needMessage: true,
        threatLevel: "red",
        confidence: 70,
        reason: "Червоний код для міста (простий аналіз)",
        cityMentioned: true,
      };
    }

    if (text.includes("помаранчев") || text.includes("оранжев")) {
      return {
        needCall: false,
        needMessage: true,
        threatLevel: "orange",
        confidence: 70,
        reason: "Помаранчевий код для міста (простий аналіз)",
        cityMentioned: true,
      };
    }

    if (
      text.includes("фіолетов") ||
      text.includes("фиолетов") ||
      text.includes(" бб ") ||
      text.includes("баліст")
    ) {
      return {
        needCall: false,
        needMessage: true,
        threatLevel: "purple",
        confidence: 70,
        reason: "Фіолетовий код / ББ для міста (простий аналіз)",
        cityMentioned: true,
      };
    }

    if (
      text.includes("відбій") ||
      text.includes("отбой") ||
      text.includes("скасов")
    ) {
      return {
        needCall: false,
        needMessage: false,
        threatLevel: "none",
        confidence: 80,
        reason: "Відбій тривоги",
        cityMentioned: true,
      };
    }

    // За замовчуванням - жовтий (місто згадується, але немає явної загрози)
    return {
      needCall: false,
      needMessage: false,
      threatLevel: "yellow",
      confidence: 60,
      reason: "Місто згадується, але загроза неясна (простий аналіз)",
      cityMentioned: true,
    };
  }

  private getThreatEmoji(level: string): string {
    switch (level) {
      case "red":
        return "🟥";
      case "orange":
        return "🟧";
      case "purple":
        return "🟪";
      case "yellow":
        return "🟨";
      default:
        return "🟩";
    }
  }
}
