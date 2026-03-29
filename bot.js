require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const cron = require('node-cron');
const { Pool } = require('pg');

// --- НАСТРОЙКИ ---
const TOKEN = process.env.TOKEN;
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// --- ИНИЦИАЛИЗАЦИЯ БОТА ---
const bot = new TelegramBot(TOKEN, { polling: true });

// --- СОЗДАНИЕ ТАБЛИЦ ПРИ ЗАПУСКЕ ---
async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS tasks (
      id SERIAL PRIMARY KEY,
      chat_id BIGINT NOT NULL,
      text TEXT NOT NULL,
      done BOOLEAN DEFAULT FALSE,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);
  console.log('База данных готова ✅');
}

// --- ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ ---
async function getTasks(chatId) {
  const res = await pool.query(
    'SELECT * FROM tasks WHERE chat_id = $1 ORDER BY created_at',
    [chatId]
  );
  return res.rows;
}

async function addTask(chatId, text) {
  await pool.query(
    'INSERT INTO tasks (chat_id, text) VALUES ($1, $2)',
    [chatId, text]
  );
}

async function markDone(taskId) {
  await pool.query('UPDATE tasks SET done = TRUE WHERE id = $1', [taskId]);
}

async function clearDone(chatId) {
  await pool.query(
    'DELETE FROM tasks WHERE chat_id = $1 AND done = TRUE',
    [chatId]
  );
}

// --- КОМАНДЫ БОТА ---

// /start
bot.onText(/\/start/, async (msg) => {
  bot.sendMessage(msg.chat.id,
    '👋 Привет! Я твой Todo-бот.\n\n' +
    'Команды:\n' +
    '/add Текст задачи — добавить задачу\n' +
    '/list — показать все задачи\n' +
    '/clear — удалить выполненные задачи'
  );
});

// /add
bot.onText(/\/add (.+)/, async (msg, match) => {
  await addTask(msg.chat.id, match[1]);
  bot.sendMessage(msg.chat.id, `✅ Задача добавлена: "${match[1]}"`);
});

// /list
bot.onText(/\/list/, async (msg) => {
  const tasks = await getTasks(msg.chat.id);
  if (tasks.length === 0) {
    bot.sendMessage(msg.chat.id, '📭 Список задач пуст. Добавь задачу через /add');
    return;
  }
  for (const task of tasks) {
    const status = task.done ? '✅' : '🔲';
    const buttons = task.done
      ? []
      : [[{ text: '✅ Выполнено', callback_data: `done_${task.id}` }]];
    await bot.sendMessage(msg.chat.id, `${status} ${task.text}`, {
      reply_markup: { inline_keyboard: buttons }
    });
  }
});

// /clear
bot.onText(/\/clear/, async (msg) => {
  await clearDone(msg.chat.id);
  bot.sendMessage(msg.chat.id, '🗑️ Выполненные задачи удалены.');
});

// Кнопка "Выполнено"
bot.on('callback_query', async (query) => {
  const taskId = parseInt(query.data.replace('done_', ''));
  const res = await pool.query('SELECT * FROM tasks WHERE id = $1', [taskId]);
  const task = res.rows[0];
  if (task) {
    await markDone(taskId);
    bot.editMessageText(`✅ Выполнено: ${task.text}`, {
      chat_id: query.message.chat.id,
      message_id: query.message.message_id
    });
  }
  bot.answerCallbackQuery(query.id);
});

// --- НАПОМИНАНИЯ ---
async function sendReminders() {
  const res = await pool.query(
    'SELECT DISTINCT chat_id FROM tasks WHERE done = FALSE'
  );
  for (const row of res.rows) {
    const tasks = await getTasks(row.chat_id);
    const pending = tasks.filter(t => !t.done);
    if (pending.length === 0) continue;
    const list = pending.map(t => `🔲 ${t.text}`).join('\n');
    bot.sendMessage(row.chat_id, `⏰ Напоминание! Незавершённые задачи:\n\n${list}`);
  }
}

cron.schedule('0 10 * * *', sendReminders); // 10:00
cron.schedule('0 14 * * *', sendReminders); // 14:00
cron.schedule('0 19 * * *', sendReminders); // 19:00

// --- ЗАПУСК ---
initDB().then(() => {
  console.log('Бот запущен! 🚀');
});
