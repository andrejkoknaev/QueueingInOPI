import { Redis } from '@upstash/redis';
import crypto from 'crypto';

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN,
});

const REDIS_KEY = 'tg_queue_events_v2';
const SUBSCRIBERS_KEY = 'tg_queue_subscribers_v1';
const LOCK_KEY = 'tg_queue_mutex_lock';

const DEFAULT_EVENTS = [
  {
    id: 'evt_default_1',
    title: 'Семинар 1. Доклады',
    totalSlots: 17,
    topics: Array.from({ length: 17 }, (_, i) => String(i + 1)),
    createdAt: new Date().toISOString(),
    bookings: []
  }
];

function isValidAdmin(login, password) {
  const envLogin = (process.env.ADMIN_LOGIN || '').trim();
  const envPass = (process.env.ADMIN_PASSWORD || '').trim();
  if (!envLogin || !envPass) return false;
  return String(login || '').trim() === envLogin && String(password || '').trim() === envPass;
}

function verifyTelegramInitData(initDataRaw) {
  const botToken = (process.env.BOT_TOKEN || '').trim();
  if (!botToken || !initDataRaw) return null;

  try {
    const params = new URLSearchParams(initDataRaw);
    const hash = params.get('hash');
    if (!hash) return null;
    params.delete('hash');

    const dataCheckString = Array.from(params.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${k}=${v}`)
      .join('\n');

    const secretKey = crypto.createHmac('sha256', 'WebAppData').update(botToken).digest();
    const calculatedHash = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');

    if (calculatedHash !== hash) return null;
    const userStr = params.get('user');
    return userStr ? JSON.parse(userStr) : null;
  } catch {
    return null;
  }
}

async function saveSubscriber(userId) {
  const idStr = String(userId || '').trim();
  if (!/^\d+$/.test(idStr)) return;
  try {
    await redis.sadd(SUBSCRIBERS_KEY, idStr);
  } catch {}
}

async function broadcastNewEvent(eventTitle, slotsCount) {
  const botToken = (process.env.BOT_TOKEN || '').trim();
  if (!botToken) return;

  try {
    const updatesRes = await fetch(`https://api.telegram.org/bot${botToken}/getUpdates?limit=100`);
    if (updatesRes.ok) {
      const updatesData = await updatesRes.json();
      if (Array.isArray(updatesData.result)) {
        for (const upd of updatesData.result) {
          const chatId = upd?.message?.chat?.id || upd?.my_chat_member?.chat?.id;
          if (chatId && Number(chatId) > 0) {
            await saveSubscriber(chatId);
          }
        }
      }
    }
  } catch {}

  try {
    const subscribers = (await redis.smembers(SUBSCRIBERS_KEY)) || [];
    if (!subscribers.length) return;

    const safeTitle = eventTitle.replace(/[<>&]/g, '');
    const text =
      `🔔 <b>Создана новая запись на выступление!</b>\n\n` +
      `📌 <b>${safeTitle}</b>\n` +
      `👥 Мест в очереди: <b>${slotsCount}</b>\n\n` +
      `Откройте мини-приложение в боте, чтобы выбрать место и тему.`;

    await Promise.allSettled(
      subscribers.map(chatId =>
        fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            chat_id: chatId,
            text,
            parse_mode: 'HTML'
          })
        })
      )
    );
  } catch {}
}

async function acquireLock(retries = 25, delayMs = 60) {
  const token = `${Date.now()}_${Math.random()}`;
  for (let i = 0; i < retries; i++) {
    const locked = await redis.set(LOCK_KEY, token, { nx: true, px: 4500 });
    if (locked === 'OK') return token;
    await new Promise(r => setTimeout(r, delayMs));
  }
  return null;
}

async function releaseLock(token) {
  try {
    if ((await redis.get(LOCK_KEY)) === token) {
      await redis.del(LOCK_KEY);
    }
  } catch {}
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');

  try {
    if (req.method === 'GET') {
      let events = await redis.get(REDIS_KEY);
      if (!Array.isArray(events)) {
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
        initData,
        adminLogin,
        adminPassword
      } = req.body || {};

      if (action === 'register_user') {
        const verifiedUser = verifyTelegramInitData(initData);
        const targetUser = verifiedUser || user;
        if (targetUser?.id) await saveSubscriber(targetUser.id);
        return res.status(200).json({ success: true });
      }

      if (action === 'admin_login') {
        if (!process.env.ADMIN_LOGIN || !process.env.ADMIN_PASSWORD) {
          return res.status(500).json({
            error: 'В настройках Vercel не заданы ADMIN_LOGIN и ADMIN_PASSWORD'
          });
        }

        const ip = (req.headers['x-forwarded-for'] || 'local').split(',')[0].trim();
        const rateKey = `tg_queue_bf_${ip}`;
        const attempts = Number((await redis.get(rateKey)) || 0);
        if (attempts >= 7) {
          return res.status(429).json({ error: 'Слишком много попыток. Подождите 1 минуту.' });
        }

        if (isValidAdmin(adminLogin, adminPassword)) {
          await redis.del(rateKey);
          return res.status(200).json({ success: true });
        }

        await redis.set(rateKey, attempts + 1, { ex: 60 });
        return res.status(401).json({ error: 'Неверный логин или пароль старосты' });
      }

      const lockToken = await acquireLock();
      if (!lockToken) {
        return res.status(503).json({ error: 'Сервер занят, повторите через секунду' });
      }

      try {
        let events = await redis.get(REDIS_KEY);
        if (!Array.isArray(events)) events = DEFAULT_EVENTS;

        if (['create_event', 'delete_event', 'admin_remove_booking'].includes(action)) {
          if (!isValidAdmin(adminLogin, adminPassword)) {
            return res.status(403).json({ error: 'Доступ запрещен: войдите как староста' });
          }

          if (action === 'create_event') {
            if (events.length >= 25) {
              return res.status(400).json({ error: 'Достигнут лимит очередей (25). Удалите старые.' });
            }

            const cleanTitle = String(title || '').trim().slice(0, 120);
            const slotsCount = Math.min(Math.max(Number(totalSlots) || 17, 1), 100);

            if (!cleanTitle) {
              return res.status(400).json({ error: 'Введите название выступления' });
            }

            let cleanTopics = Array.isArray(topics)
              ? [...new Set(topics.map(t => String(t).trim().slice(0, 240)).filter(Boolean))].slice(0, 150)
              : [];

            if (cleanTopics.length === 0) {
              cleanTopics = Array.from({ length: slotsCount }, (_, i) => String(i + 1));
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
            await broadcastNewEvent(cleanTitle, slotsCount);

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

        const verifiedUser = verifyTelegramInitData(initData);
        const effectiveUser = verifiedUser || user;

        if (!effectiveUser || !effectiveUser.id) {
          return res.status(400).json({ error: 'Не удалось определить профиль Telegram' });
        }

        await saveSubscriber(effectiveUser.id);

        const eventIndex = events.findIndex(e => e.id === eventId);
        if (eventIndex === -1) {
          return res.status(404).json({ error: 'Выступление не найдено', events });
        }

        const currentEvent = events[eventIndex];
        let bookings = currentEvent.bookings || [];

        if (action === 'cancel') {
          currentEvent.bookings = bookings.filter(b => String(b.userId) !== String(effectiveUser.id));
          events[eventIndex] = currentEvent;
          await redis.set(REDIS_KEY, events);
          return res.status(200).json({ success: true, events });
        }

        if (action === 'book') {
          const slotNum = Number(slot);
          const topicStr = String(topic || '');

          if (!Number.isInteger(slotNum) || slotNum < 1 || slotNum > currentEvent.totalSlots) {
            return res.status(400).json({ error: 'Некорректный номер места', events });
          }
          if (!currentEvent.topics.includes(topicStr)) {
            return res.status(400).json({ error: 'Выбрана несуществующая тема', events });
          }
          if (bookings.some(b => String(b.userId) === String(effectiveUser.id))) {
            return res.status(409).json({ error: 'Вы уже записаны в эту очередь!', events });
          }
          if (bookings.some(b => Number(b.slot) === slotNum)) {
            return res.status(409).json({
              error: `⚡ Место ${slotNum} заняли долей секунды раньше! Выберите другое.`,
              events
            });
          }

          const topicCounts = {};
          currentEvent.topics.forEach(t => { topicCounts[t] = 0; });
          bookings.forEach(b => {
            if (topicCounts[b.topic] !== undefined) topicCounts[b.topic]++;
          });

          const minUsage = Math.min(...Object.values(topicCounts));
          const allowedTopics = currentEvent.topics.filter(t => topicCounts[t] === minUsage);

          if (!allowedTopics.includes(topicStr)) {
            return res.status(409).json({
              error: '⚡ Эту тему перехватили долей секунды раньше! Выберите другую.',
              events
            });
          }

          const safeName = [effectiveUser.first_name, effectiveUser.last_name]
            .filter(Boolean)
            .join(' ')
            .trim()
            .slice(0, 80) || 'Участник';

          const safeUsername = effectiveUser.username
            ? `@${String(effectiveUser.username).replace(/^@/, '').slice(0, 50)}`
            : '';

          bookings.push({
            slot: slotNum,
            topic: topicStr,
            userId: String(effectiveUser.id),
            userName: safeName,
            username: safeUsername,
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
