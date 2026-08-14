require('dotenv').config();
const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const PORT = process.env.PORT || 10000;

// --- МИДЛВАРЫ (ПРОВЕРКИ) ---

// 1. Проверка авторизации (проверяет Google Токен от клиента)
const authenticateUser = async (req, res, next) => {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Нет токена авторизации' });

  const { data: { user }, error } = await supabase.auth.getUser(token);
  if (error || !user) return res.status(401).json({ error: 'Неверный токен' });

  // Достаем инфу о юзере из нашей таблицы
  const { data: dbUser } = await supabase.from('users').select('*').eq('email', user.email).single();
  
  if (!dbUser) {
    // Если юзер зашел впервые - создаем ему профиль
    const { data: newUser } = await supabase.from('users').insert([{ 
      email: user.email, 
      username: user.user_metadata.full_name || 'Player',
      avatar_url: user.user_metadata.avatar_url
    }]).select().single();
    req.user = newUser;
  } else {
    req.user = dbUser;
  }
  next();
};

// 2. Проверка на админа (для секретной страницы)
const requireAdmin = (req, res, next) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Доступ запрещен' });
  next();
};

// --- РОУТЫ ИГРОКА ---

// Получить данные своего профиля (баланс, ник, инвентарь)
app.get('/api/me', authenticateUser, async (req, res) => {
  res.json(req.user);
});

// Обновить никнейм или аватар
app.post('/api/me/update', authenticateUser, async (req, res) => {
  const { username, avatar_url } = req.body;
  const updates = {};
  if (username) updates.username = username;
  if (avatar_url) updates.avatar_url = avatar_url;

  const { data, error } = await supabase.from('users').update(updates).eq('id', req.user.id).select().single();
  if (error) return res.status(400).json({ error: error.message });
  res.json(data);
});

// --- РОУТЫ АДМИНА (СЕКРЕТНАЯ СТРАНИЦА) ---

// Добавить новый скин в базу
app.post('/api/admin/items', authenticateUser, requireAdmin, async (req, res) => {
  const { name, price, image_url, rarity } = req.body;
  const { data, error } = await supabase.from('items').insert([{ name, price, image_url, rarity }]).select();
  if (error) return res.status(400).json({ error: error.message });
  res.json({ success: true, item: data[0] });
});

// Создать новый кейс
app.post('/api/admin/cases', authenticateUser, requireAdmin, async (req, res) => {
  const { name, price, image_url } = req.body;
  const { data, error } = await supabase.from('cases').insert([{ name, price, image_url }]).select();
  if (error) return res.status(400).json({ error: error.message });
  res.json({ success: true, case: data[0] });
});

// Положить скин в кейс и задать шанс (вес)
app.post('/api/admin/case-items', authenticateUser, requireAdmin, async (req, res) => {
  const { case_id, item_id, drop_weight } = req.body;
  const { data, error } = await supabase.from('case_items').insert([{ case_id, item_id, drop_weight }]);
  if (error) return res.status(400).json({ error: error.message });
  res.json({ success: true, message: 'Скин добавлен в кейс' });
});

app.listen(PORT, () => console.log(`Backend Live on port ${PORT}`));
