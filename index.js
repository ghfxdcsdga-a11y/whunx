require('dotenv').config();
const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const cors = require('cors');
const TelegramBot = require('node-telegram-bot-api'); // Подключаем библиотеку бота

const app = express();
app.use(cors());
app.use(express.json());

// Подключаемся к Supabase с админскими правами (Service Role Key)
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const PORT = process.env.PORT || 10000;

// ==========================================
// ТЕЛЕГРАМ БОТ (МОСТ И УПРАВЛЕНИЕ)
// ==========================================

// Инициализация бота
const bot = new TelegramBot(process.env.TG_TOKEN, { polling: true });
const ADMIN_USERNAME = 'DX77TR'; // Доступ строго для этого юзернейма
let ADMIN_CHAT_ID = null; // Будет заполнен автоматически

// Обработка входящих сообщений в ТГ
bot.on('message', (msg) => {
  if (msg.from.username === ADMIN_USERNAME) {
    ADMIN_CHAT_ID = msg.chat.id; // Запоминаем чат админа при любом сообщении (или команде /start)

    // Если ты нажимаешь "Ответить" (Reply) на сообщение от юзера из поддержки
    if (msg.reply_to_message && msg.reply_to_message.text.includes('Email:')) {
      const replyText = msg.text;
      const emailMatch = msg.reply_to_message.text.match(/Email:\s*([^\s]+)/);
      
      if (emailMatch && emailMatch[1]) {
        const userEmail = emailMatch[1];
        // ТУТ в будущем можно записывать твой ответ в БД `support_chats`, 
        // чтобы фронтенд сайта его прочитал и вывел юзеру.
        bot.sendMessage(ADMIN_CHAT_ID, `✅ Ответ зафиксирован для пользователя ${userEmail}`);
      }
    }
  }
});

// Обработка нажатий на инлайн-кнопки (Выведено / Отменено)
bot.on('callback_query', async (query) => {
  // Блокируем, если жмет кто-то левый
  if (query.from.username !== ADMIN_USERNAME) {
    return bot.answerCallbackQuery(query.id, { text: 'У вас нет прав!', show_alert: true });
  }

  const action = query.data.split('_')[0]; // 'complete' или 'cancel'
  const orderId = query.data.split('_')[1];
  const newStatus = action === 'complete' ? 'completed' : 'cancelled';

  // Обновляем статус заказа в Supabase
  const { error } = await supabase.from('withdrawals').update({ status: newStatus }).eq('id', orderId);

  if (!error) {
    const statusText = action === 'complete' ? '✅ ВЫВЕДЕНО' : '❌ ОТМЕНЕНО';
    
    // Редактируем сообщение, чтобы кнопки пропали и был виден статус
    bot.editMessageText(`${query.message.text}\n\nСтатус изменен: ${statusText}`, {
      chat_id: query.message.chat.id,
      message_id: query.message.message_id
    });
    bot.answerCallbackQuery(query.id, { text: 'Статус успешно обновлен!' });
  } else {
    bot.answerCallbackQuery(query.id, { text: 'Ошибка БД!', show_alert: true });
  }
});


// ==========================================
// МИДЛВАРЫ (АВТОРИЗАЦИЯ)
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

const requireAdmin = (req, res, next) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Доступ запрещен' });
  next();
};

// ==========================================
// РОУТЫ ИГРОКА (ДАННЫЕ И НАСТРОЙКИ)
// ==========================================

app.get('/api/me', authenticateUser, (req, res) => {
  const { secret_id, ...safeUserData } = req.user; 
  res.json(safeUserData);
});

app.post('/api/me/update', authenticateUser, async (req, res) => {
  const { username, avatar_url } = req.body;
  const { data, error } = await supabase.from('users')
    .update({ username, avatar_url })
    .eq('email', req.user.email).select().single();
    
  if (error) return res.status(400).json({ error: error.message });
  res.json({ success: true, user: data });
});

// ==========================================
// ЧАТ ПОДДЕРЖКИ (САЙТ -> ТГ)
// ==========================================

app.post('/api/chat/send', authenticateUser, async (req, res) => {
  const { message } = req.body;
  
  if (ADMIN_CHAT_ID) {
    const text = `✉️ **Новое сообщение от пользователя**\nНик: ${req.user.username}\nEmail: ${req.user.email}\nID: ${req.user.secret_id}\n\nСообщение: ${message}\n\n_(Ответь на это сообщение (Reply), чтобы в будущем юзер получил ответ на сайте)_`;
    bot.sendMessage(ADMIN_CHAT_ID, text, { parse_mode: 'Markdown' });
  }
  
  res.json({ success: true });
});

// ==========================================
// ФИНАНСЫ (ПОПОЛНЕНИЕ, ВЫВОД, ПРОМОКОДЫ)
// ==========================================

app.post('/api/promo/activate', authenticateUser, async (req, res) => {
  const { code } = req.body;
  
  const { data: promo, error } = await supabase.from('promocodes').select('*').eq('code', code.toUpperCase()).eq('is_active', true).single();
  if (error || !promo) return res.status(404).json({ error: 'Промокод не существует или закончился' });

  if (promo.promo_type === 'add_gold') {
    const newBalance = Number(req.user.balance) + Number(promo.promo_value);
    await supabase.from('users').update({ balance: newBalance }).eq('id', req.user.id);
    return res.json({ success: true, message: `Начислено ${promo.promo_value} G!`, type: promo.promo_type });
  }

  res.json({ success: true, promo });
});

app.post('/api/finance/topup', authenticateUser, async (req, res) => {
  let { amount, promoCode } = req.body;
  amount = Number(amount);
  if (amount < 100) return res.status(400).json({ error: 'Минимальная сумма 100 ₸' });

  let finalGold = amount;

  if (promoCode) {
    const { data: promo } = await supabase.from('promocodes').select('*').eq('code', promoCode.toUpperCase()).eq('is_active', true).single();
    if (promo && promo.promo_type === 'deposit_percent') {
      finalGold += amount * (promo.promo_value / 100);
    }
  }

  const newBalance = Number(req.user.balance) + finalGold;
  const newWeeklyDeposit = Number(req.user.weekly_deposit) + amount;

  await supabase.from('users').update({ 
    balance: newBalance, 
    weekly_deposit: newWeeklyDeposit 
  }).eq('id', req.user.id);

  res.json({ success: true, balance: newBalance, added: finalGold });
});

app.post('/api/finance/withdraw', authenticateUser, async (req, res) => {
  // Получаем данные, которые шлет обновленный фронтенд магазина
  const { amount, gameId, gameAvatar, targetSkin, pattern } = req.body;
  const withdrawAmount = Number(amount);

  if (req.user.weekly_deposit < 100) return res.status(403).json({ error: 'Доступ к выводу закрыт. Необходим донат от 100 ₸ за неделю.' });
  if (withdrawAmount < 100) return res.status(400).json({ error: 'Минимальная сумма вывода 100 G' });
  if (req.user.balance < withdrawAmount) return res.status(400).json({ error: 'Недостаточно средств' });

  // 1. Списываем баланс в БД
  const newBalance = Number(req.user.balance) - withdrawAmount;
  await supabase.from('users').update({ balance: newBalance }).eq('id', req.user.id);

  // 2. Создаем заявку (добавил .select().single() чтобы сразу получить ID созданного заказа)
  const { data: order, error } = await supabase.from('withdrawals').insert([{
    user_email: req.user.email,
    amount: withdrawAmount,
    game_id: gameId,
    game_avatar: gameAvatar,
    target_skin: targetSkin,
    pattern: pattern,
    status: 'pending' // По дефолту в ожидании
  }]).select().single();

  // 3. ОТПРАВЛЯЕМ УВЕДОМЛЕНИЕ И КНОПКИ В ТЕЛЕГРАМ
  if (ADMIN_CHAT_ID && !error && order) {
    const tgMessage = `
🔥 **НОВЫЙ ЗАКАЗ ИЗ МАГАЗИНА!**
👤 **Юзер ID:** \`${req.user.secret_id}\`
💰 **Купил голды:** ${withdrawAmount} G
💵 **Потратил валюты сайта:** ${withdrawAmount} ₸
🔫 **Скин выставлен за:** ${targetSkin}
🎮 **Игровой ID:** ${gameId}
🎲 **Паттерн:** ${pattern}
`;

    bot.sendMessage(ADMIN_CHAT_ID, tgMessage, {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [
          [
            { text: '✅ Выведено', callback_data: `complete_${order.id}` },
            { text: '❌ Отменено', callback_data: `cancel_${order.id}` }
          ]
        ]
      }
    });
  }

  res.json({ success: true, message: 'Заявка на вывод создана', balance: newBalance });
});

// ==========================================
// СЕКРЕТНАЯ АДМИН-ПАНЕЛЬ
// ==========================================

app.post('/api/admin/items', authenticateUser, requireAdmin, async (req, res) => {
  const { name, weapon, price, rarity, img } = req.body;
  const { data, error } = await supabase.from('items').insert([{ name, weapon, price, rarity, image_url: img }]).select();
  if (error) return res.status(400).json({ error: error.message });
  res.json({ success: true, item: data[0] });
});

app.post('/api/admin/cases', authenticateUser, requireAdmin, async (req, res) => {
  const { name, price, img } = req.body;
  const { data, error } = await supabase.from('cases').insert([{ name, price, image_url: img }]).select();
  if (error) return res.status(400).json({ error: error.message });
  res.json({ success: true, case: data[0] });
});

app.post('/api/admin/case-items', authenticateUser, requireAdmin, async (req, res) => {
  const { case_id, item_id, regular_chance, stattrack_chance } = req.body;
  const { data, error } = await supabase.from('case_items').insert([{ 
    case_id, 
    item_id, 
    regular_chance, 
    stattrack_chance 
  }]);
  
  if (error) return res.status(400).json({ error: error.message });
  res.json({ success: true, message: 'Скин успешно добавлен в кейс' });
});

app.listen(PORT, () => console.log(`Backend Server Live on port ${PORT}`));
