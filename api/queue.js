import { Redis } from '@upstash/redis';

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN,
});

const REDIS_KEY = 'tg_queue_events_v2';
const LOCK_KEY = 'tg_queue_mutex_lock';

const DEFAULT_EVENTS = [
  {
    id: 'evt_default_1',
    title: 'Семинар 1. Доклады',
    totalSlots: 10,
    topics: Array.from({ length: 10 }, (_, i) => `Тема №${i + 1}`),
    createdAt: new Date().toISOString(),
    bookings: []
  }
];

function isValidAdmin(login, password) {
  const envLogin = process.env.ADMIN_LOGIN;
  const envPass = process.env.ADMIN_PASSWORD;
  if (!envLogin || !envPass) return false;
  return String(login) === String(envLogin) && String(password) === String(envPass);
}

async function acquireLock(retries = 25, delayMs = 60) {
  const token = `${Date.now()}_${Math.random()}`;
  for (let i = 0; i < retries; i++) {
    const locked = await redis.set(LOCK_KEY, token, { nx: true, px: 4000 });
    if (locked === 'OK') return token;
    await new Promise(r => setTimeout(r, delayMs));
  }
  return null;
}

async function releaseLock(token) {
  try {
    const current = await redis.get(LOCK_KEY);
    if (current === token) {
      await redis.del(LOCK_KEY);
    }
  } catch (_) {}
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');

  try {
    if (req.method === 'GET') {
      let events = await redis.get(REDIS_KEY);
      if (!events || !Array.isArray(events)) {
        events = DEFAULT_EVENTS;
        await redis.set(REDIS_KEY, events);
      }
      return res.status(200).json({ events, serverTime: Date.now() });
    }

    if (req.method === 'POST') {
      const {
        action,
        eventId,
        title,
        totalSlots,
        topics,
        slot,
        topic,
        user,
        adminLogin,
        adminPassword
      } = req.body;

      if (action === 'admin_login') {
        if (!process.env.ADMIN_LOGIN || !process.env.ADMIN_PASSWORD) {
          return res.status(500).json({
            error: 'В панели Vercel ещё не заданы переменные ADMIN_LOGIN и ADMIN_PASSWORD'
          });
        }
        if (isValidAdmin(adminLogin, adminPassword)) {
          return res.status(200).json({ success: true });
        }
        return res.status(401).json({ error: 'Неверный логин или пароль старосты' });
      }

      const lockToken = await acquireLock();
      if (!lockToken) {
        return res.status(503).json({ error: 'Сервер обрабатывает другой запрос, повторите через секунду' });
      }

      try {
        let events = (await redis.get(REDIS_KEY)) || DEFAULT_EVENTS;

        // Действия для старосты
        if (['create_event', 'delete_event', 'admin_remove_booking'].includes(action)) {
          if (!isValidAdmin(adminLogin, adminPassword)) {
            return res.status(403).json({ error: 'Доступ запрещен: требуется вход для старосты' });
          }

          if (action === 'create_event') {
            const cleanTitle = String(title || '').trim();
            const slotsCount = Math.min(Math.max(Number(totalSlots) || 10, 1), 100);

            if (!cleanTitle) {
              return res.status(400).json({ error: 'Введите название выступления' });
            }

            let cleanTopics = Array.isArray(topics)
              ? [...new Set(topics.map(t => String(t).trim()).filter(Boolean))]
              : [];

            if (cleanTopics.length === 0) {
              cleanTopics = Array.from({ length: slotsCount }, (_, i) => `Тема №${i + 1}`);
            }

            const newEvent = {
              id: 'evt_' + Date.now(),
              title: cleanTitle,
              totalSlots: slotsCount,
              topics: cleanTopics,
              createdAt: new Date().toISOString(),
              bookings: []
            };

            events.push(newEvent);
            await redis.set(REDIS_KEY, events);
            return res.status(200).json({ success: true, events, newEventId: newEvent.id });
          }

          if (action === 'delete_event') {
            events = events.filter(e => e.id !== eventId);
            await redis.set(REDIS_KEY, events);
            return res.status(200).json({ success: true, events });
          }

          if (action === 'admin_remove_booking') {
            const idx = events.findIndex(e => e.id === eventId);
            if (idx === -1) return res.status(404).json({ error: 'Очередь не найдена' });

            events[idx].bookings = (events[idx].bookings || []).filter(
              b => Number(b.slot) !== Number(slot)
            );
            await redis.set(REDIS_KEY, events);
            return res.status(200).json({ success: true, events });
          }
        }

        if (!user || !user.id) {
          return res.status(400).json({ error: 'Не удалось определить пользователя Telegram' });
        }

        const eventIndex = events.findIndex(e => e.id === eventId);
        if (eventIndex === -1) {
          return res.status(404).json({ error: 'Выбранное выступление не найдено', events });
        }

        const currentEvent = events[eventIndex];
        let bookings = currentEvent.bookings || [];

        if (action === 'cancel') {
          currentEvent.bookings = bookings.filter(b => String(b.userId) !== String(user.id));
          events[eventIndex] = currentEvent;
          await redis.set(REDIS_KEY, events);
          return res.status(200).json({ success: true, events });
        }

        if (action === 'book') {
          const slotNum = Number(slot);

          if (!slotNum || slotNum < 1 || slotNum > currentEvent.totalSlots) {
            return res.status(400).json({ error: 'Некорректный номер места', events });
          }
          if (!currentEvent.topics.includes(topic)) {
            return res.status(400).json({ error: 'Выбрана несуществующая тема', events });
          }

          if (bookings.some(b => String(b.userId) === String(user.id))) {
            return res.status(409).json({ error: 'Вы уже записаны в эту очередь!', events });
          }
          if (bookings.some(b => Number(b.slot) === slotNum)) {
            return res.status(409).json({
              error: `⚡ Кто-то оказался быстрее на доли секунды и занял место ${slotNum}! Выберите другое.`,
              events
            });
          }

          const takenTopicsSet = new Set(bookings.map(b => b.topic));
          const untakenTopics = currentEvent.topics.filter(t => !takenTopicsSet.has(t));

          if (untakenTopics.length > 0 && takenTopicsSet.has(topic)) {
            return res.status(409).json({
              error: '⚡ Эту тему перехватили долей секунды раньше! Выберите другую из свободных.',
              events
            });
          }

          bookings.push({
            slot: slotNum,
            topic,
            userId: user.id,
            userName: [user.first_name, user.last_name].filter(Boolean).join(' ') || 'Участник',
            username: user.username ? `@${user.username}` : '',
            updatedAt: new Date().toISOString()
          });

          bookings.sort((a, b) => a.slot - b.slot);
          currentEvent.bookings = bookings;
          events[eventIndex] = currentEvent;

          await redis.set(REDIS_KEY, events);
          return res.status(200).json({ success: true, events });
        }

        return res.status(400).json({ error: 'Неизвестное действие' });
      } finally {
        await releaseLock(lockToken);
      }
    }

    return res.status(405).json({ error: 'Метод не поддерживается' });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Ошибка сервера или базы данных' });
  }
}
