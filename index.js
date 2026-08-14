require('dotenv').config();
const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

// Подключаемся к Supabase с админскими правами (Service Role Key)
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const PORT = process.env.PORT || 10000;

// ==========================================
// МИДЛВАРЫ (АВТОРИЗАЦИЯ)
// ==========================================

// Проверка Google JWT токена
const authenticateUser = async (req, res, next) => {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Нет токена авторизации' });

  const { data: { user }, error } = await supabase.auth.getUser(token);
  if (error || !user) return res.status(401).json({ error: 'Неверный токен' });

  // Достаем юзера из нашей таблицы (со всеми секретными полями)
  const { data: dbUser } = await supabase.from('users').select('*').eq('email', user.email).single();
  if (!dbUser) return res.status(404).json({ error: 'Пользователь не найден в БД' });

  req.user = dbUser;
  next();
};

// Проверка прав администратора
const requireAdmin = (req, res, next) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Доступ запрещен' });
  next();
};

// ==========================================
// РОУТЫ ИГРОКА (ДАННЫЕ И НАСТРОЙКИ)
// ==========================================

// Получить свои данные (Здесь мы отдаем инфу фронту, но НЕ отдаем secret_id в целях безопасности)
app.get('/api/me', authenticateUser, (req, res) => {
  const { secret_id, ...safeUserData } = req.user; // Вырезаем секретный ID перед отправкой на клиент
  res.json(safeUserData);
});

// Обновить профиль
app.post('/api/me/update', authenticateUser, async (req, res) => {
  const { username, avatar_url } = req.body;
  const { data, error } = await supabase.from('users')
    .update({ username, avatar_url })
    .eq('email', req.user.email).select().single();
    
  if (error) return res.status(400).json({ error: error.message });
  res.json({ success: true, user: data });
});

// ==========================================
// ФИНАНСЫ (ПОПОЛНЕНИЕ, ВЫВОД, ПРОМОКОДЫ)
// ==========================================

// Проверка и активация промокода
app.post('/api/promo/activate', authenticateUser, async (req, res) => {
  const { code } = req.body;
  
  const { data: promo, error } = await supabase.from('promocodes').select('*').eq('code', code.toUpperCase()).eq('is_active', true).single();
  if (error || !promo) return res.status(404).json({ error: 'Промокод не существует или закончился' });

  // Если промокод на прямую голду
  if (promo.promo_type === 'add_gold') {
    const newBalance = Number(req.user.balance) + Number(promo.promo_value);
    await supabase.from('users').update({ balance: newBalance }).eq('id', req.user.id);
    return res.json({ success: true, message: `Начислено ${promo.promo_value} G!`, type: promo.promo_type });
  }

  // Для процентов к депозиту и бесплатных кейсов фронтенд просто сохраняет тип промокода в стейт
  res.json({ success: true, promo });
});

// Имитация успешного пополнения (Шлюз)
app.post('/api/finance/topup', authenticateUser, async (req, res) => {
  let { amount, promoCode } = req.body;
  amount = Number(amount);
  if (amount < 10) return res.status(400).json({ error: 'Минимальная сумма 10 ₽' });

  let finalGold = amount;

  // Если передан промокод на процент, проверяем его на сервере
  if (promoCode) {
    const { data: promo } = await supabase.from('promocodes').select('*').eq('code', promoCode.toUpperCase()).eq('is_active', true).single();
    if (promo && promo.promo_type === 'deposit_percent') {
      finalGold += amount * (promo.promo_value / 100);
    }
  }

  // Добавляем баланс и записываем стату доната (для разблокировки вывода)
  const newBalance = Number(req.user.balance) + finalGold;
  const newWeeklyDeposit = Number(req.user.weekly_deposit) + amount;

  await supabase.from('users').update({ 
    balance: newBalance, 
    weekly_deposit: newWeeklyDeposit 
  }).eq('id', req.user.id);

  res.json({ success: true, balance: newBalance, added: finalGold });
});

// Запрос на вывод средств
app.post('/api/finance/withdraw', authenticateUser, async (req, res) => {
  const { amount, gameId, gameAvatar, targetSkin, pattern } = req.body;
  const withdrawAmount = Number(amount);

  if (req.user.weekly_deposit < 100) return res.status(403).json({ error: 'Доступ к выводу закрыт. Необходим донат от 100 ₽ за неделю.' });
  if (withdrawAmount < 100) return res.status(400).json({ error: 'Минимальная сумма вывода 100 G' });
  if (req.user.balance < withdrawAmount) return res.status(400).json({ error: 'Недостаточно средств' });

  // Списываем баланс
  const newBalance = Number(req.user.balance) - withdrawAmount;
  await supabase.from('users').update({ balance: newBalance }).eq('id', req.user.id);

  // Создаем заявку в базе
  await supabase.from('withdrawals').insert([{
    user_email: req.user.email,
    amount: withdrawAmount,
    game_id: gameId,
    game_avatar: gameAvatar,
    target_skin: targetSkin,
    pattern: pattern
  }]);

  res.json({ success: true, message: 'Заявка на вывод создана', balance: newBalance });
});

// ==========================================
// СЕКРЕТНАЯ АДМИН-ПАНЕЛЬ
// ==========================================

// Создать скин
app.post('/api/admin/items', authenticateUser, requireAdmin, async (req, res) => {
  const { name, weapon, price, rarity, img } = req.body;
  const { data, error } = await supabase.from('items').insert([{ name, weapon, price, rarity, image_url: img }]).select();
  if (error) return res.status(400).json({ error: error.message });
  res.json({ success: true, item: data[0] });
});

// Создать кейс
app.post('/api/admin/cases', authenticateUser, requireAdmin, async (req, res) => {
  const { name, price, img } = req.body;
  const { data, error } = await supabase.from('cases').insert([{ name, price, image_url: img }]).select();
  if (error) return res.status(400).json({ error: error.message });
  res.json({ success: true, case: data[0] });
});

// Привязать скин к кейсу с уникальными шансами (Regular & StatTrack)
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
