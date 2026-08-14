require('dotenv').config();
const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

// Инициализация Supabase
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

const PORT = process.env.PORT || 10000;

app.get('/', (req, res) => {
  res.send('Backend is running!');
});

// Пример: проверка баланса пользователя
app.post('/api/check-balance', async (req, res) => {
  const { userId } = req.body;
  const { data, error } = await supabase.from('users').select('balance').eq('id', userId).single();
  
  if (error) return res.status(400).json({ error: error.message });
  res.json(data);
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
