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
// SOCKET.IO (Для выдачи призов)
// ==========================================
const server = require('http').createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

const connectedUsers = {};

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

// ==========================================
// ТЕЛЕГРАМ БОТ
// ==========================================
const bot = new TelegramBot(process.env.TG_TOKEN, { polling: true });
const ADMIN_CHAT_ID = 1210777759;

bot.onText(/^\/setplash\s+([^\s]+)\s+(\d+)$/, async (msg, match) => {
  if (msg.chat.id !== ADMIN_CHAT_ID) return;
  const userEmail = match[1].trim();
  const goldAmount = parseInt(match[2].trim());

  const socketId = connectedUsers[userEmail];
  if (socketId) {
    io.to(socketId).emit('open_plashka', { amount: goldAmount });
    bot.sendMessage(ADMIN_CHAT_ID, `✅ Модалка выдачи приза на ${goldAmount} G отправлена пользователю ${userEmail}.`);
  } else {
    bot.sendMessage(ADMIN_CHAT_ID, `⚠️ Пользователь ${userEmail} сейчас не онлайн (вкладка закрыта).\nПопросите его зайти на главную страницу сайта и повторите команду.`);
  }
});

bot.onText(/^\/checkbal\s+(.+)$/, async (msg, match) => {
  if (msg.chat.id !== ADMIN_CHAT_ID) return;
  const secretId = match[1].trim();
  const { data: user } = await supabase.from('users').select('*').eq('secret_id', secretId).single();
  if (!user) return bot.sendMessage(ADMIN_CHAT_ID, '❌ Пользователь с таким ID не найден.');
  
  const { data: txs } = await supabase.from('transactions').select('*').eq('user_email', user.email).order('created_at', { ascending: true });
  let response = `👤 **Пользователь:** ${user.username}\n📧 **Почта:** ${user.email}\n💰 **Текущий баланс:** ${user.balance} ₸\n\n**📊 История изменений баланса:**\n`;
  
  if (!txs || txs.length === 0) { response += '`Транзакций пока нет.`'; } 
  else {
    txs.forEach(tx => {
      const d = new Date(tx.created_at);
      const time = d.toLocaleTimeString('ru-RU', { timeZone: 'Asia/Almaty', hour: '2-digit', minute: '2-digit' });
      const date = d.toLocaleDateString('ru-RU', { timeZone: 'Asia/Almaty' });
      const sign = (tx.type === 'deposit' || tx.type === 'refund') ? '+' : '-';
      response += `[${date} ${time}] ${sign}${tx.amount} ₸ (${tx.description})\n`;
    });
  }
  bot.sendMessage(ADMIN_CHAT_ID, response, { parse_mode: 'Markdown' });
});

bot.on('message', async (msg) => {
  if (msg.chat.id === ADMIN_CHAT_ID && msg.reply_to_message && msg.reply_to_message.text && msg.reply_to_message.text.includes('Почта:')) {
    const replyText = msg.text;
    const emailMatch = msg.reply_to_message.text.match(/Почта:\s*([^\s\n]+)/);
    if (emailMatch && emailMatch[1]) {
      const userEmail = emailMatch[1];
      await supabase.from('support_messages').insert([{ user_email: userEmail, sender: 'admin', text: replyText }]);
      bot.sendMessage(ADMIN_CHAT_ID, `✅ Ответ отправлен пользователю ${userEmail}`);
    }
  }
});

bot.on('callback_query', async (query) => {
  if (query.from.id !== ADMIN_CHAT_ID) return bot.answerCallbackQuery(query.id, { text: 'Доступ запрещен!', show_alert: true });

  const action = query.data.split('_')[0]; 
  const orderId = query.data.split('_')[1];

  if (action === 'approvetopup' || action === 'rejecttopup') {
    const { data: request } = await supabase.from('topup_requests').select('*').eq('id', orderId).single();
    if (!request) return bot.answerCallbackQuery(query.id, { text: 'Заявка не найдена', show_alert: true });
    if (request.status !== 'pending') return bot.answerCallbackQuery(query.id, { text: 'Заявка уже обработана!', show_alert: true });

    if (action === 'approvetopup') {
      const { data: user } = await supabase.from('users').select('*').eq('email', request.user_email).single();
      if (user) {
        const newBalance = Number(user.balance) + Number(request.amount);
        await supabase.from('users').update({ balance: newBalance }).eq('email', request.user_email);
        await supabase.from('transactions').insert([{ user_email: request.user_email, type: 'deposit', amount: request.amount, description: 'Пополнение Kaspi' }]);
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
  if (!order) return bot.answerCallbackQuery(query.id, { text: 'Заказ не найден', show_alert: true });
  if (order.status !== 'pending') return bot.answerCallbackQuery(query.id, { text: 'Заказ уже обработан!', show_alert: true });

  const newStatus = action === 'complete' ? 'completed' : 'cancelled';

  if (action === 'cancel') {
    const { data: user } = await supabase.from('users').select('balance').eq('email', order.user_email).single();
    if (user && order.spent_rubles > 0) { 
      const newBalance = Number(user.balance) + Number(order.spent_rubles);
      await supabase.from('users').update({ balance: newBalance }).eq('email', order.user_email);
      await supabase.from('transactions').insert([{ user_email: order.user_email, type: 'refund', amount: order.spent_rubles, description: `Возврат за отмену заказа #${order.id}` }]);
    }
  }

  await supabase.from('withdrawals').update({ status: newStatus }).eq('id', orderId);

  const statusText = action === 'complete' ? '✅ ВЫВЕДЕНО' : '❌ ОТМЕНЕНО';
  const originalText = query.message.caption || query.message.text;
  const newText = `${originalText}\n\nСтатус заказа: ${statusText}`;

  const opts = { chat_id: query.message.chat.id, message_id: query.message.message_id, reply_markup: { inline_keyboard: [] } };
  if (query.message.photo) bot.editMessageCaption(newText, opts).catch(err => console.error(err));
  else bot.editMessageText(newText, opts).catch(err => console.error(err));

  bot.answerCallbackQuery(query.id, { text: 'Статус обновлен!' });
});

// ==========================================
// МИДЛВАРЫ
// ==========================================
const authenticateUser = async (req, res, next) => {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Нет токена авторизации' });
  const { data: { user }, error } = await supabase.auth.getUser(token);
  if (error || !user) return res.status(401).json({ error: 'Неверный токен' });
  const { data: dbUser } = await supabase.from('users').select('*').eq('email', user.email).single();
  if (!dbUser) return res.status(404).json({ error: 'Пользователь не найден в БД' });
  req.user = dbUser;
  next();
};

// ==========================================
// БАЗОВЫЕ РОУТЫ
// ==========================================
app.get('/api/me', authenticateUser, (req, res) => { res.json(req.user); });

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

app.get('/api/chat/history', authenticateUser, async (req, res) => {
  const { data } = await supabase.from('support_messages').select('*').eq('user_email', req.user.email).order('created_at', { ascending: true });
  res.json({ success: true, messages: data || [] });
});

app.post('/api/chat/send', authenticateUser, async (req, res) => {
  const { message } = req.body;
  await supabase.from('support_messages').insert([{ user_email: req.user.email, sender: 'user', text: message }]);
  bot.sendMessage(ADMIN_CHAT_ID, `✉️ **Новое сообщение в техподдержку**\n👤 **Ник:** ${req.user.username}\n📧 **Почта:** ${req.user.email}\n🔑 **ID:** \`${req.user.secret_id}\`\n\nСообщение: ${message}`, { parse_mode: 'Markdown' });
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
  if (error) return res.status(500).json({ error: 'Ошибка базы данных' });

  const tgMessage = `💵 **НОВАЯ ЗАЯВКА НА ПОПОЛНЕНИЕ (KASPI)!**\n👤 **Ник:** ${req.user.username}\n📧 **Почта:** ${req.user.email}\n💰 **Сумма:** ${amount} ₸`;
  bot.sendMessage(ADMIN_CHAT_ID, tgMessage, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[ { text: '✅ Зачислить', callback_data: `approvetopup_${request.id}` }, { text: '❌ Не пришли', callback_data: `rejecttopup_${request.id}` } ]] } });
  res.json({ success: true, message: 'Заявка отправлена администратору' });
});

app.post('/api/finance/withdraw', authenticateUser, async (req, res) => {
  const { amount, gameId, gameAvatar, targetSkin, pattern, spentTenge } = req.body;
  const withdrawAmount = Number(amount);

  if (req.user.balance < spentTenge) return res.status(400).json({ error: 'Недостаточно средств на балансе' });

  const { data: order, error } = await supabase.from('withdrawals').insert([{
    user_email: req.user.email, amount: withdrawAmount, game_id: gameId, game_avatar: gameAvatar, target_skin: targetSkin, pattern: pattern, spent_rubles: spentTenge, status: 'pending'
  }]).select().single();

  if (error) return res.status(500).json({ error: 'Сбой базы данных. Заказ не создан.' });

  let newBalance = req.user.balance;
  if (spentTenge > 0) {
    newBalance = Number(req.user.balance) - Number(spentTenge);
    await supabase.from('users').update({ balance: newBalance }).eq('id', req.user.id);
    await supabase.from('transactions').insert([{ user_email: req.user.email, type: 'withdrawal', amount: spentTenge, description: `Покупка ${withdrawAmount} G` }]);
  }

  if (order) {
    const title = spentTenge === 0 ? '🎁 **ВЫДАЧА ПРИЗА РОЗЫГРЫША!**' : '🔥 **НОВЫЙ ЗАКАЗ ГОЛДЫ!**';
    const tgMessage = `${title}\n👤 **Ник:** ${req.user.username}\n📧 **Почта:** ${req.user.email}\n🔑 **ID:** \`${req.user.secret_id}\`\n💰 **Количество:** ${withdrawAmount} G\n💵 **Списано:** ${spentTenge} ₸\n🔫 **Скин:** ${targetSkin}\n🎮 **Игровой ID:** ${gameId}\n🎲 **Паттерн:** ${pattern}`;
    const tgOptions = { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[ { text: '✅ Выведено', callback_data: `complete_${order.id}` }, { text: '❌ Отменено', callback_data: `cancel_${order.id}` } ]] } };

    if (gameAvatar && gameAvatar !== 'default' && gameAvatar.startsWith('data:image')) {
      const imageBuffer = Buffer.from(gameAvatar.replace(/^data:image\/\w+;base64,/, ""), 'base64');
      tgOptions.caption = tgMessage;
      bot.sendPhoto(ADMIN_CHAT_ID, imageBuffer, tgOptions).catch(() => bot.sendMessage(ADMIN_CHAT_ID, tgMessage, tgOptions));
    } else {
      bot.sendMessage(ADMIN_CHAT_ID, tgMessage, tgOptions);
    }
  }
  res.json({ success: true, message: 'Заявка на вывод создана', balance: newBalance });
});

// ==========================================
// ПРОМОКОДЫ
// ==========================================
app.post('/api/promocodes/activate', authenticateUser, async (req, res) => {
  const { code } = req.body;
  
  const { data: promo } = await supabase.from('promocodes').select('*').eq('code', code).single();
  if (!promo || !promo.is_active) return res.status(404).json({ error: 'Промокод не найден или недействителен' });
  
  if (promo.expires_at && new Date() > new Date(promo.expires_at)) {
      return res.status(400).json({ error: 'Срок действия промокода истек' });
  }
  
  if (promo.max_activations > 0 && promo.used_activations >= promo.max_activations) {
      return res.status(400).json({ error: 'Лимит активаций этого промокода исчерпан' });
  }

  const { data: used } = await supabase.from('used_promocodes').select('id').eq('user_email', req.user.email).eq('promo_code', code).single();
  if (used) return res.status(400).json({ error: 'Вы уже активировали этот промокод' });

  if (promo.reward_type === 'balance') {
      const newBalance = Number(req.user.balance) + Number(promo.reward_value);
      await supabase.from('users').update({ balance: newBalance }).eq('id', req.user.id);
      
      await supabase.from('transactions').insert([{ user_email: req.user.email, type: 'deposit', amount: promo.reward_value, description: `Промокод: ${code}` }]);
      await supabase.from('used_promocodes').insert([{ user_email: req.user.email, promo_code: code }]);
      await supabase.from('promocodes').update({ used_activations: promo.used_activations + 1 }).eq('id', promo.id);

      return res.json({ success: true, type: 'balance', value: promo.reward_value, new_balance: newBalance });
  } 
  else if (promo.reward_type === 'discount') {
      await supabase.from('used_promocodes').insert([{ user_email: req.user.email, promo_code: code }]);
      await supabase.from('promocodes').update({ used_activations: promo.used_activations + 1 }).eq('id', promo.id);
      
      return res.json({ success: true, type: 'discount', value: promo.reward_value });
  }
});


// ==========================================
// ОТЗЫВЫ И ИДЕИ
// ==========================================
app.post('/api/reviews/add', authenticateUser, async (req, res) => {
  const { rating, comment, image } = req.body;
  if (!rating || rating < 1 || rating > 5) return res.status(400).json({ error: 'Некорректная оценка' });

  const { data: wList, error: wErr } = await supabase.from('withdrawals').select('id').eq('user_email', req.user.email).eq('status', 'completed');
  if (wErr || !wList || wList.length === 0) return res.status(403).json({ error: 'Оставить отзыв могут только пользователи с успешными выводами!' });

  const { data: rList } = await supabase.from('reviews').select('id').eq('user_email', req.user.email);
  if (rList && rList.length >= wList.length) return res.status(403).json({ error: 'Вы исчерпали лимит отзывов. 1 покупка = 1 отзыв.' });

  const { error } = await supabase.from('reviews').insert([{ 
      user_email: req.user.email, username: req.user.username, avatar_url: req.user.avatar_url, rating: rating, comment: comment, image_url: image
  }]);
  
  if (error) return res.status(500).json({ error: 'Ошибка при сохранении отзыва' });
  res.json({ success: true, message: 'Отзыв успешно добавлен!' });
});

app.get('/api/reviews/list', async (req, res) => {
  const { data, error } = await supabase.from('reviews').select('*').order('created_at', { ascending: false });
  if (error) return res.status(500).json({ error: 'Ошибка БД' });
  res.json({ success: true, reviews: data });
});

app.post('/api/ideas/add', authenticateUser, async (req, res) => {
  const { idea_text } = req.body;
  if (!idea_text) return res.status(400).json({ error: 'Текст идеи не может быть пустым' });

  const oneDayAgo = new Date(); oneDayAgo.setDate(oneDayAgo.getDate() - 1);
  const { data: recent } = await supabase.from('ideas').select('id').eq('user_email', req.user.email).gte('created_at', oneDayAgo.toISOString());
  if (recent && recent.length > 0) return res.status(403).json({ error: 'Предлагать идеи можно 1 раз в сутки!' });

  const { error } = await supabase.from('ideas').insert([{ user_email: req.user.email, idea_text }]);
  if (error) return res.status(500).json({ error: 'Ошибка при сохранении' });
  res.json({ success: true, message: 'Идея отправлена на модерацию!' });
});

app.get('/api/ideas/list', async (req, res) => {
  const { data, error } = await supabase.from('ideas').select('*').order('created_at', { ascending: false });
  if (error) return res.status(500).json({ error: 'Ошибка БД' });
  res.json({ success: true, ideas: data });
});

// ==========================================
// РОЗЫГРЫШИ
// ==========================================
app.get('/api/giveaways/active', async (req, res) => {
  const { data, error } = await supabase.from('giveaways').select('*').eq('is_active', true).order('end_time', { ascending: true });
  if (error) return res.status(500).json({ error: 'Ошибка БД' });
  res.json({ success: true, giveaways: data });
});

app.post('/api/giveaways/end', async (req, res) => {
  const { gwId } = req.body;
  const { data: gw } = await supabase.from('giveaways').select('*').eq('id', gwId).single();
  if (!gw || !gw.is_active) return res.json({ success: true }); 
  
  let participants = gw.participants || [];
  let winner = null;

  if (participants.length > 0) {
      winner = participants[Math.floor(Math.random() * participants.length)];
      bot.sendMessage(ADMIN_CHAT_ID, `🎉 **Розыгрыш на ${gw.amount} G завершен!**\n\n🏆 **Победитель:** ${winner.nickname}\n📧 **Email:** ${winner.email}\n✈️ **Telegram:** ${winner.tg || 'Не указан'}\n\nЧтобы выдать приз, отправь команду:\n\`/setplash ${winner.email} ${gw.amount}\``, { parse_mode: 'Markdown' });
  } else {
      winner = { nickname: 'Нет участников', avatar: 'whunx_pp.png' };
      bot.sendMessage(ADMIN_CHAT_ID, `📢 **Розыгрыш на ${gw.amount} G завершен!**\nПобедителей нет, никто не участвовал.`);
  }
  
  await supabase.from('giveaways').update({ is_active: false, winner: winner, ended_at: new Date().toISOString() }).eq('id', gwId);
  res.json({ success: true });
});

app.post('/api/giveaways/participate', authenticateUser, async (req, res) => {
  const { gwId } = req.body;

  if (!req.user.tg_id) { 
      return res.status(400).json({ error: 'Для участия необходимо привязать Telegram в настройках!' });
  }
  
  const { data: gw } = await supabase.from('giveaways').select('*').eq('id', gwId).single();
  if (!gw || !gw.is_active) return res.status(400).json({ error: 'Розыгрыш не активен' });

  if (gw.require_sub && gw.tg_channels && gw.tg_channels.length > 0) {
      for (let channel of gw.tg_channels) {
          try {
              const chatId = channel.startsWith('@') ? channel : '@' + channel;
              const member = await bot.getChatMember(chatId, req.user.tg_id);
              if (member.status === 'left' || member.status === 'kicked' || member.status === 'restricted') {
                  return res.status(400).json({ error: `Вы не подписаны на канал ${channel}!` });
              }
          } catch (err) {
              console.error(`Ошибка проверки подписки на ${channel}:`, err.message);
              return res.status(400).json({ error: `Системная ошибка проверки канала ${channel}. Бот не является администратором канала!` });
          }
      }
  }
  
  let participants = gw.participants || [];
  if (participants.find(p => p.email === req.user.email)) return res.status(400).json({ error: 'Вы уже участвуете!' });
  
  if (gw.max_participants && gw.max_participants !== '∞' && participants.length >= gw.max_participants) {
      return res.status(400).json({ error: 'Мест больше нет!' });
  }
  
  participants.push({
      email: req.user.email, nickname: req.user.username, avatar: req.user.avatar_url, tg: req.user.telegram_username || req.user.tg_id
  });
  
  await supabase.from('giveaways').update({ participants }).eq('id', gwId);
  res.json({ success: true });
});

// АВТОПИНГ
app.get('/api/ping', (req, res) => res.send('Сервер не спит!'));
setInterval(() => { https.get('https://whunx-backend.onrender.com/api/ping', (resp) => {}); }, 14 * 60 * 1000);

server.listen(PORT, () => console.log(`Backend Server Live on port ${PORT}`));
