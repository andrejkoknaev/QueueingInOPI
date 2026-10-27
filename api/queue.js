import { Redis } from '@upstash/redis';

// Автоматическое подключение к базе из переменных окружения Vercel
const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN,
});

const REDIS_KEY = 'tg_queue_bookings_v1';

// Настройте количество мест и список тем под свою задачу:
const TOTAL_SLOTS = 15;
const TOPICS = [
  'Тема 1. Архитектура клиент-серверных приложений',
  'Тема 2. Бессерверные вычисления (Serverless)',
  'Тема 3. Проектирование реляционных баз данных',
  'Тема 4. Нереляционные БД и кэширование в Redis',
  'Тема 5. REST API и GraphQL: сравнение подходов',
  'Тема 6. Контейнеризация и основы Docker',
  'Тема 7. Безопасность веб-приложений (OWASP Top 10)',
  'Тема 8. Аутентификация: JWT, OAuth 2.0 и сессии',
  'Тема 9. Микросервисная архитектура и брокеры сообщений',
  'Тема 10. Оптимизация производительности фронтенда',
  'Тема 11. CI/CD пайплайны и автоматизация деплоя',
  'Тема 12. Тестирование ПО: Unit, Integration, E2E',
  'Тема 13. WebSockets и приложения реального времени',
  'Тема 14. Облачные провайдеры и балансировка нагрузки',
  'Тема 15. Мониторинг и логирование (Prometheus, Grafana)'
];

export default async function handler(req, res) {
  try {
    let bookings = (await redis.get(REDIS_KEY)) || [];

    // 1. Получение текущего состояния очереди
    if (req.method === 'GET') {
      return res.status(200).json({
        totalSlots: TOTAL_SLOTS,
        topics: TOPICS,
        bookings
      });
    }

    // 2. Запись в очередь или отмена записи
    if (req.method === 'POST') {
      const { action, slot, topic, user } = req.body;

      if (!user || !user.id) {
        return res.status(400).json({ error: 'Не удалось определить пользователя Telegram' });
      }

      // Отмена своей записи
      if (action === 'cancel') {
        bookings = bookings.filter(b => String(b.userId) !== String(user.id));
        await redis.set(REDIS_KEY, bookings);
        return res.status(200).json({ success: true, bookings });
      }

      // Новая запись
      if (action === 'book') {
        const slotNum = Number(slot);

        if (!slotNum || slotNum < 1 || slotNum > TOTAL_SLOTS) {
          return res.status(400).json({ error: 'Некорректный номер места' });
        }
        if (!TOPICS.includes(topic)) {
          return res.status(400).json({ error: 'Выбрана несуществующая тема' });
        }

        // Проверка 1: Записан ли уже этот пользователь
        if (bookings.some(b => String(b.userId) === String(user.id))) {
          return res.status(409).json({ error: 'Вы уже записаны в очередь. Сначала отмените текущую запись.' });
        }

        // Проверка 2: Свободно ли место
        if (bookings.some(b => Number(b.slot) === slotNum)) {
          return res.status(409).json({ error: `Место №${slotNum} только что заняли! Выберите другое.` });
        }

        // Проверка 3: Свободна ли тема
        if (bookings.some(b => b.topic === topic)) {
          return res.status(409).json({ error: 'Эту тему уже забрали! Выберите другую.' });
        }

        const newEntry = {
          slot: slotNum,
          topic,
          userId: user.id,
          userName: [user.first_name, user.last_name].filter(Boolean).join(' ') || 'Без имени',
          username: user.username ? `@${user.username}` : '',
          updatedAt: new Date().toISOString()
        };

        bookings.push(newEntry);
        bookings.sort((a, b) => a.slot - b.slot);

        await redis.set(REDIS_KEY, bookings);
        return res.status(200).json({ success: true, bookings });
      }
    }

    return res.status(405).json({ error: 'Метод не поддерживается' });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Ошибка сервера или не подключена БД Redis' });
  }
}
