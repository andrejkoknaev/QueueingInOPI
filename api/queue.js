import { Redis } from '@upstash/redis';

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN,
});

const REDIS_KEY = 'tg_queue_events_v2';

const DEFAULT_EVENTS = [
  {
    id: 'evt_default_1',
    title: 'Семинар 1. Доклады',
    totalSlots: 10,
    topics: [],
    createdBy: null,
    createdAt: new Date().toISOString(),
    bookings: []
  }
];

export default async function handler(req, res) {
  try {
    let events = await redis.get(REDIS_KEY);
    if (!events || !Array.isArray(events)) {
      events = DEFAULT_EVENTS;
      await redis.set(REDIS_KEY, events);
    }

    if (req.method === 'GET') {
      return res.status(200).json({ events });
    }

    if (req.method === 'POST') {
      const { action, eventId, title, totalSlots, topics, slot, topic, user } = req.body;

      if (!user || !user.id) {
        return res.status(400).json({ error: 'Не удалось определить пользователя Telegram' });
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
          createdBy: String(user.id),
          creatorName: [user.first_name, user.last_name].filter(Boolean).join(' ') || 'Староста',
          createdAt: new Date().toISOString(),
          bookings: []
        };

        events.push(newEvent);
        await redis.set(REDIS_KEY, events);
        return res.status(200).json({ success: true, events, newEventId: newEvent.id });
      }

      if (action === 'delete_event') {
        const target = events.find(e => e.id === eventId);
        if (!target) {
          return res.status(404).json({ error: 'Запись не найдена' });
        }
        if (target.createdBy && String(target.createdBy) !== String(user.id)) {
          return res.status(403).json({ error: 'Удалить запись может только её создатель' });
        }

        events = events.filter(e => e.id !== eventId);
        await redis.set(REDIS_KEY, events);
        return res.status(200).json({ success: true, events });
      }

      const eventIndex = events.findIndex(e => e.id === eventId);
      if (eventIndex === -1) {
        return res.status(404).json({ error: 'Выбранное выступление не найдено' });
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
          return res.status(400).json({ error: 'Некорректный номер места' });
        }
        if (!currentEvent.topics.includes(topic)) {
          return res.status(400).json({ error: 'Выбрана несуществующая тема' });
        }

        if (bookings.some(b => String(b.userId) === String(user.id))) {
          return res.status(409).json({ error: 'Вы уже записаны на это выступление!' });
        }
        if (bookings.some(b => Number(b.slot) === slotNum)) {
          return res.status(409).json({ error: `Место №${slotNum} уже заняли! Выберите другое.` });
        }
        if (bookings.some(b => b.topic === topic)) {
          return res.status(409).json({ error: 'Эту тему уже выбрали! Выберите другую.' });
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
    }

    return res.status(405).json({ error: 'Метод не поддерживается' });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Ошибка сервера или базы данных' });
  }
}
