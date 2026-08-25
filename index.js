require('dotenv').config();
const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const cors = require('cors');
const TelegramBot = require('node-telegram-bot-api');
const https = require('https');
const { Server } = require('socket.io');

const app = express();
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const PORT = process.env.PORT || 10000;

// ==========================================
// SOCKET.IO И ГЛОБАЛЬНЫЕ ТАЙМЕРЫ ЧАТОВ
// ==========================================
const server = require('http').createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

const connectedUsers = {};
const resolveTimeouts = {}; // Хранит таймеры 5-минутного закрытия чатов

io.on('connection', (socket) => {
  socket.on('register_client', async (data) => {
    try {
      const { data: { user } } = await supabase.auth.getUser(data.token);
      if (user) connectedUsers[user.email] = socket.id;
    } catch (e) {}
  });

  socket.on('disconnect', () => {
    for (let email in connectedUsers) {
      if (connectedUsers[email] === socket.id) delete connectedUsers[email];
    }
  });
});

async function closeAndClearChat(userEmail) {
    // Удаляем всю историю из БД (ЭКОНОМИЯ EGRESS)
    await supabase.from('support_messages').delete().eq('user_email', userEmail);
    // Отправляем сигнал на очистку клиенту
    const socketId = connectedUsers[userEmail];
    if (socketId) io.to(socketId).emit('chat_closed');
    // Сбрасываем таймер
    if (resolveTimeouts[userEmail]) {
        clearTimeout(resolveTimeouts[userEmail]);
        delete resolveTimeouts[userEmail];
    }
}

// ==========================================
// КЭШИРОВАНИЕ ТОПОВ (БОРЬБА С EGRESS)
// ==========================================
let topsCacheData = { d: [], w: [], i: [], ck: [], cg: [] };

async function updateTopsCache() {
    try {
        const [d, w, i, ck, cg] = await Promise.all([
            supabase.rpc('get_top_donators'),
            supabase.rpc('get_top_withdrawals'),
            supabase.rpc('get_top_ideas'),
            supabase.rpc('get_top_charity_kzt'),
            supabase.rpc('get_top_charity_gold')
        ]);
        topsCacheData = {
            d: d.data || [], w: w.data || [], i: i.data || [], ck: ck.data || [], cg: cg.data || []
        };
    } catch (err) {}
}
setInterval(updateTopsCache, 60000);
updateTopsCache();

app.get('/api/tops/cache', (req, res) => {
    res.json({ success: true, data: topsCacheData });
});

// ==========================================
// ТЕЛЕГРАМ БОТ
// ==========================================
const bot = new TelegramBot(process.env.TG_TOKEN, { polling: true });
const ADMIN_CHAT_ID = 1210777759;

bot.onText(/^\/setplash\s+([^\s]+)\s+(\d+)$/, async (msg, match) => {
  if (msg.chat.id !== ADMIN_CHAT_ID) return;
  const userEmail = match[1].trim(); const goldAmount = parseInt(match[2].trim());
  const socketId = connectedUsers[userEmail];
  if (socketId) {
    io.to(socketId).emit('open_plashka', { amount: goldAmount });
    bot.sendMessage(ADMIN_CHAT_ID, `✅ Модалка выдачи приза на ${goldAmount} G отправлена пользователю ${userEmail}.`);
  } else bot.sendMessage(ADMIN_CHAT_ID, `⚠️ Пользователь ${userEmail} сейчас не онлайн.`);
});

bot.onText(/^\/setdar\s+([^\s]+)\s+([^\s]+)\s+([^\s]+)\s+([\d.]+)$/, async (msg, match) => {
  if (msg.chat.id !== ADMIN_CHAT_ID) return;
  const userEmail = match[1].trim(); const gameId = match[2].trim(); const pattern = match[3].trim(); const skinPrice = parseFloat(match[4].trim());
  const { data: donate, error } = await supabase.from('donations').select('*').eq('user_email', userEmail).eq('donate_type', 'gold').eq('status', 'pending').order('created_at', { ascending: false }).limit(1).single();
  if (error || !donate) return bot.sendMessage(ADMIN_CHAT_ID, `❌ Заявка на донат голдой не найдена.`);
  await supabase.from('donations').update({ game_id: gameId, skin_pattern: pattern, skin_price: skinPrice, status: 'waiting_skin' }).eq('id', donate.id);

  const socketId = connectedUsers[userEmail];
  if (socketId) {
    io.to(socketId).emit('donation_skin_ready', { gameId, pattern, skinPrice });
    bot.sendMessage(ADMIN_CHAT_ID, `✅ Данные скина отправлены юзеру.`);
  }
});

bot.onText(/^\/start BIND_(.+)$/, async (msg, match) => {
  const secretId = match[1].trim(); const tgId = msg.from.id; const tgUsername = msg.from.username || null;
  const { data: targetUser } = await supabase.from('users').select('*').eq('secret_id', secretId).single();
  if (!targetUser) return bot.sendMessage(msg.chat.id, '❌ Аккаунт не найден.');

  const { data: existingUser } = await supabase.from('users').select('*').eq('tg_id', tgId).maybeSingle();
  if (existingUser) {
      if (existingUser.secret_id === secretId) {
          if (existingUser.telegram_username !== tgUsername) await supabase.from('users').update({ telegram_username: tgUsername }).eq('secret_id', secretId);
          return bot.sendMessage(msg.chat.id, `✅ Telegram синхронизирован!`);
      }
      return bot.sendMessage(msg.chat.id, `❌ Ошибка: Этот Telegram уже привязан к другому аккаунту.`);
  }

  await supabase.from('users').update({ tg_id: tgId, telegram_username: tgUsername }).eq('secret_id', secretId);
  bot.sendMessage(msg.chat.id, `✅ Аккаунт успешно привязан!\n👤 Никнейм: ${targetUser.username}`);
});

bot.onText(/^\/checkbal\s+(.+)$/, async (msg, match) => {
  if (msg.chat.id !== ADMIN_CHAT_ID) return;
  const secretId = match[1].trim();
  const { data: user } = await supabase.from('users').select('*').eq('secret_id', secretId).single();
  if (!user) return bot.sendMessage(ADMIN_CHAT_ID, '❌ Пользователь не найден.');
  
  const { data: txs } = await supabase.from('transactions').select('*').eq('user_email', user.email).order('created_at', { ascending: true });
  let response = `👤 **Пользователь:** ${user.username}\n💰 **Баланс:** ${user.balance} ₸\n\n`;
  if (!txs || txs.length === 0) response += '`Транзакций пока нет.`';
  else {
    txs.forEach(tx => {
      const d = new Date(tx.created_at);
      const time = d.toLocaleTimeString('ru-RU', { timeZone: 'Asia/Almaty', hour: '2-digit', minute: '2-digit' });
      const sign = (tx.type === 'deposit' || tx.type === 'refund') ? '+' : '-';
      response += `[${time}] ${sign}${tx.amount} ₸ (${tx.description})\n`;
    });
  }
  bot.sendMessage(ADMIN_CHAT_ID, response, { parse_mode: 'Markdown' });
});

// ВЫДАЧА МУТА (Команда из Telegram)
bot.onText(/^\/mute\s+([^\s]+)\s+(\d+)\s+(.+)$/, async (msg, match) => {
    if (msg.chat.id !== ADMIN_CHAT_ID) return;
    const userEmail = match[1]; const minutes = parseInt(match[2]); const reason = match[3];
    
    const muteUntil = new Date(Date.now() + minutes * 60000).toISOString();
    const { data, error } = await supabase.from('users').update({ mute_until: muteUntil }).eq('email', userEmail).select().single();
    if (error || !data) return bot.sendMessage(ADMIN_CHAT_ID, `❌ Ошибка: Пользователь ${userEmail} не найден.`);
    
    const socketId = connectedUsers[userEmail];
    if (socketId) io.to(socketId).emit('chat_muted', { mute_until: muteUntil });
    
    bot.sendMessage(ADMIN_CHAT_ID, `🔇 Пользователю ${userEmail} выдан мут на ${minutes} мин.\nПричина: ${reason}`);
});

bot.on('message', async (msg) => {
  // ОТВЕТ АДМИНА В ТЕХПОДДЕРЖКЕ С ПОДДЕРЖКОЙ ФОТО
  if (msg.chat.id === ADMIN_CHAT_ID && msg.reply_to_message && msg.reply_to_message.text && msg.reply_to_message.text.includes('Почта:')) {
    const replyText = msg.text || msg.caption || '';
    const emailMatch = msg.reply_to_message.text.match(/Почта:\s*([^\s\n]+)/);
    if (emailMatch && emailMatch[1]) {
      const userEmail = emailMatch[1];
      let imagesArray = [];

      // Если админ прикрепил фото
      if (msg.photo && msg.photo.length > 0) {
          const photo = msg.photo[msg.photo.length - 1]; // Берем лучшее качество
          const fileLink = await bot.getFileLink(photo.file_id);
          try {
              const imgResp = await fetch(fileLink);
              const buffer = await imgResp.arrayBuffer();
              const base64 = Buffer.from(buffer).toString('base64');
              imagesArray.push(`data:image/jpeg;base64,${base64}`);
          } catch(e) { console.error("Ошибка загрузки фото админа", e); }
      }

      // Если в таблице support_messages нет колонки role/images, они не сохранятся, но мы передадим их по сокету
      const msgData = { user_email: userEmail, sender: 'admin', text: replyText, images: imagesArray, role: 'creator' };
      await supabase.from('support_messages').insert([{ user_email: userEmail, sender: 'admin', text: replyText }]); // Сохраняем хотя бы текст
      
      bot.sendMessage(ADMIN_CHAT_ID, `✅ Ответ отправлен пользователю ${userEmail}`);
      const socketId = connectedUsers[userEmail];
      if (socketId) io.to(socketId).emit('new_chat_message', msgData);
    }
  }
});

bot.on('callback_query', async (query) => {
  if (query.from.id !== ADMIN_CHAT_ID) return;

  // ОБРАБОТКА НОВЫХ КНОПОК ПОДДЕРЖКИ
  if (query.data.startsWith('respr_')) {
      const userEmail = query.data.substring(6);
      const msgData = { user_email: userEmail, sender: 'admin', type: 'resolve_prompt', text: 'Пожалуйста, подтвердите, решена ли ваша проблема:' };
      
      const { data: savedMsg } = await supabase.from('support_messages').insert([msgData]).select().single();
      const socketId = connectedUsers[userEmail];
      if (socketId) io.to(socketId).emit('chat_resolve_prompt', savedMsg);
      
      // Таймер на авто-закрытие через 5 минут
      resolveTimeouts[userEmail] = setTimeout(async () => {
          await closeAndClearChat(userEmail);
          bot.sendMessage(ADMIN_CHAT_ID, `⏳ Чат с ${userEmail} автоматически закрыт (Тайм-аут 5 мин).`);
      }, 5 * 60 * 1000);
      
      bot.answerCallbackQuery(query.id, { text: 'Вопрос отправлен!' });
      return bot.editMessageText(`${query.message.text}\n\n[❓ Запрошено подтверждение решения]`, { chat_id: query.message.chat.id, message_id: query.message.message_id });
  }
  else if (query.data.startsWith('closechat_')) {
      const userEmail = query.data.substring(10);
      await closeAndClearChat(userEmail);
      bot.answerCallbackQuery(query.id, { text: 'Чат принудительно закрыт!' });
      return bot.editMessageText(`${query.message.text}\n\n[🔒 Чат принудительно закрыт администратором]`, { chat_id: query.message.chat.id, message_id: query.message.message_id });
  }
  else if (query.data.startsWith('mutebtn_')) {
      const userEmail = query.data.substring(8);
      bot.answerCallbackQuery(query.id);
      return bot.sendMessage(ADMIN_CHAT_ID, `Для выдачи мута скопируйте команду и вставьте свои значения:\n\`/mute ${userEmail} [минуты] [причина]\`\n\nПример: \`/mute ${userEmail} 60 Оскорбление\``, { parse_mode: 'Markdown' });
  }

  // СТАРЫЕ ОБРАБОТЧИКИ
  const action = query.data.split('_')[0]; 
  const orderId = query.data.split('_')[1];

  if (action === 'approvedonate' || action === 'rejectdonate') {
    const { data: donate } = await supabase.from('donations').select('*').eq('id', orderId).single();
    if (!donate) return bot.answerCallbackQuery(query.id, { text: 'Донат не найден', show_alert: true });
    
    const newStatus = action === 'approvedonate' ? 'approved' : 'rejected';
    await supabase.from('donations').update({ status: newStatus }).eq('id', orderId);

    const socketId = connectedUsers[donate.user_email];
    if (socketId) {
        if (newStatus === 'approved') io.to(socketId).emit('donation_approved');
        else io.to(socketId).emit('donation_rejected');
    }

    const statusText = newStatus === 'approved' ? '✅ ДОНАТ ПОДТВЕРЖДЕН' : '❌ ДОНАТ ОТКЛОНЕН / ОТМЕНЕН';
    bot.editMessageText(`${query.message.text}\n\nСтатус: ${statusText}`, { chat_id: query.message.chat.id, message_id: query.message.message_id });
    return bot.answerCallbackQuery(query.id, { text: 'Решение по донату принято!' });
  }

  if (action === 'approvetopup' || action === 'rejecttopup') {
    const { data: request } = await supabase.from('topup_requests').select('*').eq('id', orderId).single();
    if (!request || request.status !== 'pending') return;

    if (action === 'approvetopup') {
      const { data: user } = await supabase.from('users').select('*').eq('email', request.user_email).single();
      if (user) {
        const newBalance = Number(user.balance) + Number(request.amount);
        await supabase.from('users').update({ balance: newBalance }).eq('email', request.user_email);
        await supabase.from('transactions').insert([{ user_email: request.user_email, type: 'deposit', amount: request.amount, description: 'Пополнение Kaspi' }]);
        const socketId = connectedUsers[request.user_email];
        if (socketId) io.to(socketId).emit('balance_updated', { balance: newBalance });
      }
      await supabase.from('topup_requests').update({ status: 'approved' }).eq('id', orderId);
      bot.editMessageText(`${query.message.text}\n\nСтатус: ✅ ЗАЧИСЛЕНО НА БАЛАНС`, { chat_id: query.message.chat.id, message_id: query.message.message_id });
    } else {
      await supabase.from('topup_requests').update({ status: 'rejected' }).eq('id', orderId);
      bot.editMessageText(`${query.message.text}\n\nСтатус: ❌ ПЛАТЕЖ НЕ НАЙДЕН`, { chat_id: query.message.chat.id, message_id: query.message.message_id });
    }
    return bot.answerCallbackQuery(query.id, { text: 'Заявка обработана!' });
  }

  const { data: order } = await supabase.from('withdrawals').select('*').eq('id', orderId).single();
  if (!order || order.status !== 'pending') return;

  const newStatus = action === 'complete' ? 'completed' : 'cancelled';

  if (action === 'cancel') {
    const { data: user } = await supabase.from('users').select('balance').eq('email', order.user_email).single();
    if (user && order.spent_rubles > 0) { 
      const newBalance = Number(user.balance) + Number(order.spent_rubles);
      await supabase.from('users').update({ balance: newBalance }).eq('email', order.user_email);
      await supabase.from('transactions').insert([{ user_email: order.user_email, type: 'refund', amount: order.spent_rubles, description: `Возврат за отмену заказа #${order.id}` }]);
      const socketId = connectedUsers[order.user_email];
      if (socketId) io.to(socketId).emit('balance_updated', { balance: newBalance });
    }
    if (order.applied_promo) await supabase.from('used_promocodes').update({ is_spent: false }).eq('user_email', order.user_email).eq('promo_code', order.applied_promo);
  }

  await supabase.from('withdrawals').update({ status: newStatus }).eq('id', orderId);
  const statusText = action === 'complete' ? '✅ ВЫВЕДЕНО' : '❌ ОТМЕНЕНО';
  const newText = `${query.message.caption || query.message.text}\n\nСтатус заказа: ${statusText}`;
  const opts = { chat_id: query.message.chat.id, message_id: query.message.message_id, reply_markup: { inline_keyboard: [] } };
  if (query.message.photo) bot.editMessageCaption(newText, opts).catch(err => console.error(err));
  else bot.editMessageText(newText, opts).catch(err => console.error(err));
});

// ==========================================
// МИДЛВАРЫ
// ==========================================
const authenticateUser = async (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) return res.status(401).json({ error: 'Нет токена авторизации' });
  
  try {
    const { data: { user }, error } = await supabase.auth.getUser(authHeader.split(' ')[1]);
    if (error || !user) return res.status(401).json({ error: 'Неверный токен' });
    
    const { data: dbUser } = await supabase.from('users').select('*').eq('email', user.email).single();
    if (!dbUser) return res.status(404).json({ error: 'Пользователь не найден в БД' });
    
    if (dbUser.email === 'ghfxdcsdga@gmail.com' && dbUser.role !== 'creator') {
        await supabase.from('users').update({ role: 'creator' }).eq('id', dbUser.id);
        dbUser.role = 'creator';
    }

    req.user = dbUser;
    next();
  } catch (err) { res.status(401).json({ error: 'Ошибка авторизации' }); }
};

// ==========================================
// НОВЫЕ РОУТЫ ЧАТА ПОДДЕРЖКИ
// ==========================================
app.get('/api/chat/history', authenticateUser, async (req, res) => {
    const now = new Date();
    const isMuted = req.user.mute_until && new Date(req.user.mute_until) > now;

    const { data } = await supabase.from('support_messages').select('*').eq('user_email', req.user.email).order('created_at', { ascending: true });
    
    // Если в таблице нет колонок role и images, они просто не вернутся, но текст будет
    res.json({ 
        success: true, 
        messages: data || [], 
        muted: !!isMuted, 
        mute_until: isMuted ? req.user.mute_until : null 
    });
});

app.post('/api/chat/send', authenticateUser, async (req, res) => {
    const { message, images } = req.body;
    
    const now = new Date();
    if (req.user.mute_until && new Date(req.user.mute_until) > now) {
        return res.status(403).json({ error: 'Чат заблокирован' });
    }

    // Сохраняем в БД (Колонки images может не быть, но текст сохранится)
    await supabase.from('support_messages').insert([{ user_email: req.user.email, sender: 'user', text: message }]);

    let tgText = `✉️ **Новое обращение**\n👤 **Ник:** ${req.user.username}\n📧 **Почта:** ${req.user.email}\n🔑 **ID:** \`${req.user.secret_id}\`\n\nСообщение: ${message || '[Только фото]'}`;
    
    const keyboard = {
        inline_keyboard: [
            [{ text: '❓ Проблема решена?', callback_data: `respr_${req.user.email}` }],
            [{ text: '🔒 Закрыть чат', callback_data: `closechat_${req.user.email}` }, { text: '🔇 Мут', callback_data: `mutebtn_${req.user.email}` }]
        ]
    };

    try {
        if (images && images.length > 0) {
            // Отправляем фото админу
            for (let img of images) {
                const buffer = Buffer.from(img.replace(/^data:image\/\w+;base64,/, ""), 'base64');
                await bot.sendPhoto(ADMIN_CHAT_ID, buffer);
            }
        }
        bot.sendMessage(ADMIN_CHAT_ID, tgText, { parse_mode: 'Markdown', reply_markup: keyboard });
    } catch (err) { console.error(err); }

    res.json({ success: true });
});

app.post('/api/chat/resolve-answer', authenticateUser, async (req, res) => {
    const { msgId, answer } = req.body;
    
    // Удаляем промпт из БД, чтобы он больше не выводился при релоаде
    if (msgId) await supabase.from('support_messages').delete().eq('id', msgId);
    
    if (resolveTimeouts[req.user.email]) {
        clearTimeout(resolveTimeouts[req.user.email]);
        delete resolveTimeouts[req.user.email];
    }

    if (answer === 'yes') {
        await closeAndClearChat(req.user.email);
        bot.sendMessage(ADMIN_CHAT_ID, `✅ Пользователь ${req.user.email} подтвердил решение проблемы. Чат закрыт и очищен.`);
    } else {
        await supabase.from('support_messages').insert([{ user_email: req.user.email, sender: 'user', text: '[Пользователь указал, что проблема НЕ решена]' }]);
        bot.sendMessage(ADMIN_CHAT_ID, `❌ Пользователь ${req.user.email} указал, что проблема НЕ решена! Чат продолжается.`);
        
        const socketId = connectedUsers[req.user.email];
        if (socketId) io.to(socketId).emit('new_chat_message', { sender: 'user', text: '[Проблема не решена]' });
    }
    res.json({ success: true });
});

app.get('/api/chat/check-mute', authenticateUser, async (req, res) => {
    const now = new Date();
    const isMuted = req.user.mute_until && new Date(req.user.mute_until) > now;
    res.json({ success: true, muted: !!isMuted, mute_until: isMuted ? req.user.mute_until : null });
});


// ==========================================
// БАЗОВЫЕ РОУТЫ
// ==========================================
app.get('/api/me', authenticateUser, async (req, res) => {
  let userData = { ...req.user };
  const { data: usedList } = await supabase.from('used_promocodes').select('promo_code').eq('user_email', userData.email).eq('is_spent', false).limit(1);

  if (usedList && usedList.length > 0) {
    const { data: promo } = await supabase.from('promocodes').select('*').eq('code', usedList[0].promo_code).single();
    if (promo && promo.is_active && (!promo.expires_at || new Date() < new Date(promo.expires_at))) {
       userData.active_discount = { code: promo.code, percent: promo.reward_value, target: promo.target_item_id, expires_at: promo.expires_at };
    }
  }
  res.json(userData);
});

app.post('/api/me/update', authenticateUser, async (req, res) => {
  const { username, avatar_url } = req.body;
  const { data, error } = await supabase.from('users').update({ username, avatar_url }).eq('email', req.user.email).select().single();
  if (error) return res.status(400).json({ error: error.message });
  res.json({ success: true, user: data });
});

app.get('/api/notifications', authenticateUser, async (req, res) => {
  const { data: withdrawals } = await supabase.from('withdrawals').select('*').eq('user_email', req.user.email).neq('status', 'pending').eq('is_notified', false);
  const { data: topups } = await supabase.from('topup_requests').select('*').eq('user_email', req.user.email).neq('status', 'pending').eq('is_notified', false);
  res.json({ success: true, notifications: { withdrawals: withdrawals || [], topups: topups || [] } });
});

app.post('/api/notifications/read', authenticateUser, async (req, res) => {
  const { withdrawalIds, topupIds } = req.body;
  if (withdrawalIds && withdrawalIds.length > 0) await supabase.from('withdrawals').update({ is_notified: true }).in('id', withdrawalIds).eq('user_email', req.user.email);
  if (topupIds && topupIds.length > 0) await supabase.from('topup_requests').update({ is_notified: true }).in('id', topupIds).eq('user_email', req.user.email);
  res.json({ success: true });
});

// ==========================================
// ФИНАНСЫ И МАГАЗИН
// ==========================================
app.get('/api/shop/items', async (req, res) => {
  const { data, error } = await supabase.from('shop_items').select('*').order('id', { ascending: true });
  if (error) return res.status(500).json({ error: 'Ошибка БД' });
  res.json({ success: true, items: data });
});

app.post('/api/finance/topup', authenticateUser, async (req, res) => {
  let { amount } = req.body;
  if (Number(amount) < 100) return res.status(400).json({ error: 'Минимальная сумма 100 ₸' });
  const { data: request, error } = await supabase.from('topup_requests').insert([{ user_email: req.user.email, amount: Number(amount), status: 'pending' }]).select().single();
  
  const tgMessage = `💵 **НОВАЯ ЗАЯВКА НА ПОПОЛНЕНИЕ (KASPI)!**\n👤 **Ник:** ${req.user.username}\n📧 **Почта:** ${req.user.email}\n💰 **Сумма:** ${amount} ₸`;
  bot.sendMessage(ADMIN_CHAT_ID, tgMessage, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[ { text: '✅ Зачислить', callback_data: `approvetopup_${request.id}` }, { text: '❌ Не пришли', callback_data: `rejecttopup_${request.id}` } ]] } });
  res.json({ success: true, message: 'Заявка отправлена администратору' });
});

app.post('/api/finance/withdraw', authenticateUser, async (req, res) => {
  const { amount, gameId, gameAvatar, targetSkin, pattern, spentTenge, appliedPromoCode } = req.body;
  if (req.user.balance < spentTenge) return res.status(400).json({ error: 'Недостаточно средств на балансе' });

  if (appliedPromoCode) {
      await supabase.from('used_promocodes').update({ is_spent: true }).eq('user_email', req.user.email).eq('promo_code', appliedPromoCode);
  }

  const { data: order } = await supabase.from('withdrawals').insert([{
    user_email: req.user.email, amount: Number(amount), game_id: gameId, game_avatar: gameAvatar, target_skin: targetSkin, pattern: pattern, spent_rubles: spentTenge, status: 'pending', applied_promo: appliedPromoCode || null
  }]).select().single();

  let newBalance = req.user.balance;
  if (spentTenge > 0) {
    newBalance = Number(req.user.balance) - Number(spentTenge);
    await supabase.from('users').update({ balance: newBalance }).eq('id', req.user.id);
    await supabase.from('transactions').insert([{ user_email: req.user.email, type: 'withdrawal', amount: spentTenge, description: `Покупка ${amount} G` }]);
  }

  if (order) {
    const title = spentTenge === 0 ? '🎁 **ВЫДАЧА ПРИЗА РОЗЫГРЫША!**' : '🔥 **НОВЫЙ ЗАКАЗ ГОЛДЫ!**';
    const tgMessage = `${title}\n👤 **Ник:** ${req.user.username}\n📧 **Почта:** ${req.user.email}\n🔑 **ID:** \`${req.user.secret_id}\`\n💰 **Количество:** ${amount} G\n💵 **Списано:** ${spentTenge} ₸\n🔫 **Скин:** ${targetSkin}\n🎮 **Игровой ID:** ${gameId}\n🎲 **Паттерн:** ${pattern}`;
    const tgOptions = { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[ { text: '✅ Выведено', callback_data: `complete_${order.id}` }, { text: '❌ Отменено', callback_data: `cancel_${order.id}` } ]] } };
    bot.sendMessage(ADMIN_CHAT_ID, tgMessage, tgOptions);
  }
  res.json({ success: true, message: 'Заявка на вывод создана', balance: newBalance });
});

app.post('/api/donate/create', authenticateUser, async (req, res) => {
  const { type, amount } = req.body;
  const { data: donate } = await supabase.from('donations').insert([{ user_email: req.user.email, donate_type: type, amount: Number(amount), status: 'pending' }]).select().single();

  if (type === 'kzt') {
    bot.sendMessage(ADMIN_CHAT_ID, `💎 **НОВЫЙ ДОНАТ (ТЕНГЕ)!**\n👤 Ник: ${req.user.username}\n💰 Сумма: ${amount} ₸`, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[ { text: '✅ Подтвердить', callback_data: `approvedonate_${donate.id}` }, { text: '❌ Отклонить', callback_data: `rejectdonate_${donate.id}` } ]] } });
  } else if (type === 'gold') {
    bot.sendMessage(ADMIN_CHAT_ID, `💎 **НОВЫЙ ДОНАТ (ГОЛДА)!**\n👤 Ник: ${req.user.username}\n💰 Сумма: ${amount} G\n\n\`/setdar ${req.user.email} GAME_ID ПАТТЕРН ЦЕНА\``, { parse_mode: 'Markdown' });
  }
  res.json({ success: true, donateId: donate.id });
});

app.post('/api/donate/confirm-skin', authenticateUser, async (req, res) => {
  const { data: donate } = await supabase.from('donations').select('*').eq('user_email', req.user.email).eq('donate_type', 'gold').eq('status', 'waiting_skin').order('created_at', { ascending: false }).limit(1).single();
  if (!donate) return res.status(404).json({ error: 'Донат не найден' });
  
  await supabase.from('donations').update({ status: 'pending_verification' }).eq('id', donate.id);
  bot.sendMessage(ADMIN_CHAT_ID, `🛒 **ДОНАТЕР КУПИЛ СКИН!**\n👤 Ник: ${req.user.username}\n💰 Донат: ${donate.amount} G\n🎮 ID: ${donate.game_id} | За: ${donate.skin_price} G`, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[ { text: '✅ Подтвердить', callback_data: `approvedonate_${donate.id}` }, { text: '❌ Отклонить', callback_data: `rejectdonate_${donate.id}` } ]] } });
  res.json({ success: true });
});

// ==========================================
// ПРОМОКОДЫ
// ==========================================
app.post('/api/promocodes/activate', authenticateUser, async (req, res) => {
  const { code } = req.body;
  const { data: promo } = await supabase.from('promocodes').select('*').eq('code', code).single();
  if (!promo || !promo.is_active) return res.status(404).json({ error: 'Промокод не найден' });
  
  const { data: used } = await supabase.from('used_promocodes').select('*').eq('user_email', req.user.email).eq('promo_code', code).single();
  if (used) {
      if (promo.reward_type === 'balance') return res.status(400).json({ error: 'Уже активировали' });
      if (used.is_spent) return res.status(400).json({ error: 'Уже совершили покупку' });
      return res.json({ success: true, type: 'discount', restored: true, value: promo.reward_value, target: promo.target_item_id, code: promo.code });
  }

  if (promo.reward_type === 'balance') {
      const newBalance = Number(req.user.balance) + Number(promo.reward_value);
      await supabase.from('users').update({ balance: newBalance }).eq('id', req.user.id);
      await supabase.from('used_promocodes').insert([{ user_email: req.user.email, promo_code: code, is_spent: true }]);
      return res.json({ success: true, type: 'balance', value: promo.reward_value, new_balance: newBalance });
  } 
  else if (promo.reward_type === 'discount') {
      await supabase.from('used_promocodes').insert([{ user_email: req.user.email, promo_code: code, is_spent: false }]);
      return res.json({ success: true, type: 'discount', value: promo.reward_value, target: promo.target_item_id, code: promo.code });
  }
});

// ==========================================
// ОТЗЫВЫ И ИДЕИ
// ==========================================
app.post('/api/reviews/add', authenticateUser, async (req, res) => {
  const { rating, comment, image } = req.body;
  await supabase.from('reviews').insert([{ user_email: req.user.email, username: req.user.username, avatar_url: req.user.avatar_url, rating, comment, image_url: image, user_role: req.user.role }]);
  res.json({ success: true, message: 'Отзыв успешно добавлен!' });
});

app.get('/api/reviews/list', async (req, res) => {
  const { data } = await supabase.from('reviews').select('*').order('created_at', { ascending: false });
  res.json({ success: true, reviews: data });
});

app.post('/api/ideas/add', authenticateUser, async (req, res) => {
  const { idea_text, images } = req.body; 
  await supabase.from('ideas').insert([{ user_email: req.user.email, username: req.user.username, avatar_url: req.user.avatar_url, idea_text, images: images || [], user_role: req.user.role }]);
  res.json({ success: true, message: 'Идея отправлена!' });
});

app.get('/api/ideas/list', async (req, res) => {
  const { data } = await supabase.from('ideas').select('*').order('created_at', { ascending: false });
  res.json({ success: true, ideas: data });
});

// ==========================================
// РОЗЫГРЫШИ
// ==========================================
app.get('/api/giveaways/active', async (req, res) => {
  const { data } = await supabase.from('giveaways').select('*').eq('is_active', true).order('end_time', { ascending: true });
  res.json({ success: true, giveaways: data });
});

app.post('/api/giveaways/end', async (req, res) => {
  const { gwId } = req.body;
  const { data: gw } = await supabase.from('giveaways').select('*').eq('id', gwId).single();
  if (!gw || !gw.is_active) return res.json({ success: true }); 
  
  let participants = gw.participants || [];
  let winner = participants.length > 0 ? participants[Math.floor(Math.random() * participants.length)] : { nickname: 'Нет участников', avatar: 'whunx_pp.png' };
  
  await supabase.from('giveaways').update({ is_active: false, winner: winner, ended_at: new Date().toISOString() }).eq('id', gwId);
  res.json({ success: true });
});

app.post('/api/giveaways/participate', async (req, res) => {
  const { gwId, userEmail } = req.body;
  const { data: user } = await supabase.from('users').select('*').eq('email', userEmail).single();
  const { data: gw } = await supabase.from('giveaways').select('*').eq('id', gwId).single();

  let participants = gw.participants || [];
  participants.push({ email: user.email, nickname: user.username, avatar: user.avatar_url, tg: user.telegram_username || user.tg_id });
  await supabase.from('giveaways').update({ participants }).eq('id', gwId);
  res.json({ success: true });
});

// АВТОПИНГ
app.get('/api/ping', (req, res) => res.send('Сервер не спит!'));
setInterval(() => { https.get('https://whunx-backend.onrender.com/api/ping', (resp) => {}); }, 14 * 60 * 1000);

server.listen(PORT, () => console.log(`Backend Server Live on port ${PORT}`));
