require('dotenv').config();
const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const cors = require('cors');
const TelegramBot = require('node-telegram-bot-api');

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ limit: '10mb', extended: true }));

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const PORT = process.env.PORT || 10000;

// ==========================================
// ТЕЛЕГРАМ БОТ
// ==========================================
const bot = new TelegramBot(process.env.TG_TOKEN, { polling: true });
const ADMIN_CHAT_ID = 1210777759;

// Команда /checkbal
bot.onText(/^\/checkbal\s+(.+)$/, async (msg, match) => {
  if (msg.chat.id !== ADMIN_CHAT_ID) return;
  const secretId = match[1].trim();

  // Ищем юзера по ID
  const { data: user } = await supabase.from('users').select('*').eq('secret_id', secretId).single();
  if (!user) return bot.sendMessage(ADMIN_CHAT_ID, '❌ Пользователь с таким ID не найден.');

  // Достаем его транзакции
  const { data: txs } = await supabase.from('transactions').select('*').eq('user_email', user.email).order('created_at', { ascending: true });

  let response = `👤 **Пользователь:** ${user.username}\n📧 **Почта:** ${user.email}\n💰 **Текущий баланс:** ${user.balance} ₸\n\n**📊 История изменений баланса:**\n`;
  
  if (!txs || txs.length === 0) {
    response += '`Транзакций пока нет.`';
  } else {
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

// Ответ в чат техподдержки
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

// Кнопки "Выведено" / "Отменено"
bot.on('callback_query', async (query) => {
  if (query.from.id !== ADMIN_CHAT_ID) {
    return bot.answerCallbackQuery(query.id, { text: 'Доступ запрещен!', show_alert: true });
  }

  const action = query.data.split('_')[0]; 
  const orderId = query.data.split('_')[1];

  const { data: order } = await supabase.from('withdrawals').select('*').eq('id', orderId).single();
  if (!order) return bot.answerCallbackQuery(query.id, { text: 'Заказ не найден', show_alert: true });
  if (order.status !== 'pending') return bot.answerCallbackQuery(query.id, { text: 'Заказ уже обработан!', show_alert: true });

  const newStatus = action === 'complete' ? 'completed' : 'cancelled';

  // Логика отмены и ВОЗВРАТА СРЕДСТВ
  if (action === 'cancel') {
    const { data: user } = await supabase.from('users').select('balance').eq('email', order.user_email).single();
    if (user) {
      const newBalance = Number(user.balance) + Number(order.spent_rubles);
      await supabase.from('users').update({ balance: newBalance }).eq('email', order.user_email);
      // Записываем возврат в логи
      await supabase.from('transactions').insert([{
        user_email: order.user_email,
        type: 'refund',
        amount: order.spent_rubles,
        description: `Возврат за отмену заказа #${order.id}`
      }]);
    }
  }

  await supabase.from('withdrawals').update({ status: newStatus }).eq('id', orderId);

  const statusText = action === 'complete' ? '✅ ВЫВЕДЕНО' : '❌ ОТМЕНЕНО';
  bot.editMessageText(`${query.message.text}\n\nСтатус заказа: ${statusText}`, { chat_id: query.message.chat.id, message_id: query.message.message_id });
  bot.answerCallbackQuery(query.id, { text: 'Статус успешно обновлен!' });
});

// ==========================================
// МИДЛВАРЫ И РОУТЫ
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

app.get('/api/me', authenticateUser, (req, res) => { res.json(req.user); });

app.post('/api/me/update', authenticateUser, async (req, res) => {
  const { username, avatar_url } = req.body;
  const { data, error } = await supabase.from('users').update({ username, avatar_url }).eq('email', req.user.email).select().single();
  if (error) return res.status(400).json({ error: error.message });
  res.json({ success: true, user: data });
});

// Получение отложенных уведомлений (Статусы заказов)
app.get('/api/notifications', authenticateUser, async (req, res) => {
  const { data } = await supabase.from('withdrawals').select('*').eq('user_email', req.user.email).neq('status', 'pending').eq('is_notified', false);
  res.json({ success: true, notifications: data || [] });
});

// Пометка уведомлений как прочитанных
app.post('/api/notifications/read', authenticateUser, async (req, res) => {
  const { ids } = req.body;
  if (ids && ids.length > 0) {
    await supabase.from('withdrawals').update({ is_notified: true }).in('id', ids).eq('user_email', req.user.email);
  }
  res.json({ success: true });
});

app.get('/api/chat/history', authenticateUser, async (req, res) => {
  const { data } = await supabase.from('support_messages').select('*').eq('user_email', req.user.email).order('created_at', { ascending: true });
  res.json({ success: true, messages: data || [] });
});

app.post('/api/chat/send', authenticateUser, async (req, res) => {
  const { message } = req.body;
  await supabase.from('support_messages').insert([{ user_email: req.user.email, sender: 'user', text: message }]);
  const text = `✉️ **Новое сообщение в техподдержку**\n👤 **Ник:** ${req.user.username}\n📧 **Почта:** ${req.user.email}\n🔑 **ID:** \`${req.user.secret_id}\`\n\nСообщение: ${message}`;
  bot.sendMessage(ADMIN_CHAT_ID, text, { parse_mode: 'Markdown' });
  res.json({ success: true });
});

app.post('/api/finance/topup', authenticateUser, async (req, res) => {
  let { amount } = req.body;
  amount = Number(amount);
  if (amount < 100) return res.status(400).json({ error: 'Минимальная сумма 100 ₸' });

  const newBalance = Number(req.user.balance) + amount;
  await supabase.from('users').update({ balance: newBalance, weekly_deposit: Number(req.user.weekly_deposit) + amount }).eq('id', req.user.id);
  
  // Логируем пополнение
  await supabase.from('transactions').insert([{ user_email: req.user.email, type: 'deposit', amount: amount, description: 'Пополнение баланса' }]);
  
  res.json({ success: true, balance: newBalance });
});

app.post('/api/finance/withdraw', authenticateUser, async (req, res) => {
  const { amount, gameId, gameAvatar, targetSkin, pattern, spentTenge } = req.body;
  const withdrawAmount = Number(amount);

  if (req.user.balance < spentTenge) return res.status(400).json({ error: 'Недостаточно средств на балансе' });

  const { data: order, error } = await supabase.from('withdrawals').insert([{
    user_email: req.user.email,
    amount: withdrawAmount,
    game_id: gameId,
    game_avatar: gameAvatar,
    target_skin: targetSkin,
    pattern: pattern,
    spent_rubles: spentTenge,
    status: 'pending'
  }]).select().single();

  if (error) return res.status(500).json({ error: 'Сбой базы данных. Заказ не создан.' });

  const newBalance = Number(req.user.balance) - Number(spentTenge);
  await supabase.from('users').update({ balance: newBalance }).eq('id', req.user.id);

  // Логируем вывод
  await supabase.from('transactions').insert([{ user_email: req.user.email, type: 'withdrawal', amount: spentTenge, description: `Покупка ${withdrawAmount} G` }]);

  if (order) {
    const tgMessage = `🔥 **НОВЫЙ ЗАКАЗ ГОЛДЫ!**\n👤 **Ник:** ${req.user.username}\n📧 **Почта:** ${req.user.email}\n🔑 **ID на сайте:** \`${req.user.secret_id}\`\n💰 **Количество:** ${withdrawAmount} G\n💵 **Списано:** ${spentTenge} ₸\n🔫 **Выставить скин за:** ${targetSkin}\n🎮 **Игровой ID:** ${gameId}\n🎲 **Паттерн:** ${pattern}`;
    bot.sendMessage(ADMIN_CHAT_ID, tgMessage, {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [[ { text: '✅ Выведено', callback_data: `complete_${order.id}` }, { text: '❌ Отменено', callback_data: `cancel_${order.id}` } ]]
      }
    });
  }

  res.json({ success: true, message: 'Заявка на вывод создана', balance: newBalance });
});

app.listen(PORT, () => console.log(`Backend Server Live on port ${PORT}`));
