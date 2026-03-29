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

const bot = new TelegramBot(TOKEN, { polling: true });

// --- ИНИЦИАЛИЗАЦИЯ БД ---
async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS tasks (
      id SERIAL PRIMARY KEY,
      chat_id BIGINT NOT NULL,
      text TEXT NOT NULL,
      deadline TEXT DEFAULT NULL,
      done BOOLEAN DEFAULT FALSE,
      reminded BOOLEAN DEFAULT FALSE,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);
  await pool.query(`ALTER TABLE tasks ADD COLUMN IF NOT EXISTS deadline TEXT DEFAULT NULL`);
  await pool.query(`ALTER TABLE tasks ADD COLUMN IF NOT EXISTS reminded BOOLEAN DEFAULT FALSE`);
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

async function addTask(chatId, text, deadline = null) {
  await pool.query(
    'INSERT INTO tasks (chat_id, text, deadline) VALUES ($1, $2, $3)',
    [chatId, text, deadline]
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

function formatTask(task) {
  const status = task.done ? '✅' : '🔲';
  const deadline = task.deadline ? ` ⏰ ${task.deadline}` : '';
  return `${status} ${task.text}${deadline}`;
}

// --- КОМАНДЫ БОТА ---

bot.onText(/\/start/, (msg) => {
  bot.sendMessage(msg.chat.id,
    '👋 Привет! Я твой Todo-бот.\n\n' +
    'Команды:\n' +
    '/add Текст задачи — добавить задачу\n' +
    '/add Текст задачи 18:00 — добавить задачу с дедлайном\n' +
    '/list — показать все задачи\n' +
    '/clear — удалить выполненные задачи'
  );
});

bot.onText(/\/add (.+)/, async (msg, match) => {
  const input = match[1].trim();
  const timeMatch = input.match(/^(.*)\s(\d{1,2}:\d{2})$/);

  let text, deadline;
  if (timeMatch) {
    text = timeMatch[1].trim();
    deadline = timeMatch[2];
  } else {
    text = input;
    deadline = null;
  }

  await addTask(msg.chat.id, text, deadline);

  const reply = deadline
    ? `✅ Задача добавлена: "${text}" ⏰ ${deadline}\n🔔 Напомню за 30 минут до дедлайна`
    : `✅ Задача добавлена: "${text}"`;

  bot.sendMessage(msg.chat.id, reply);
});

bot.onText(/\/list/, async (msg) => {
  const tasks = await getTasks(msg.chat.id);
  if (tasks.length === 0) {
    bot.sendMessage(msg.chat.id, '📭 Список задач пуст. Добавь задачу через /add');
    return;
  }
  for (const task of tasks) {
    const buttons = task.done
      ? []
      : [[{ text: '✅ Выполнено', callback_data: `done_${task.id}` }]];
    await bot.sendMessage(msg.chat.id, formatTask(task), {
      reply_markup: { inline_keyboard: buttons }
    });
  }
});

bot.onText(/\/clear/, async (msg) => {
  await clearDone(msg.chat.id);
  bot.sendMessage(msg.chat.id, '🗑️ Выполненные задачи удалены.');
});

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

// --- ДНЕВНЫЕ СВОДКИ (10:00, 15:00, 21:00) ---
async function sendDailySummary(timeLabel) {
  const res = await pool.query(
    'SELECT DISTINCT chat_id FROM tasks WHERE done = FALSE'
  );
  for (const row of res.rows) {
    const tasks = await getTasks(row.chat_id);
    const pending = tasks.filter(t => !t.done);
    if (pending.length === 0) continue;
    const list = pending.map(t => formatTask(t)).join('\n');
    bot.sendMessage(row.chat_id,
      `🌅 Сводка на ${timeLabel}. Незавершённые задачи:\n\n${list}`
    );
  }
}

cron.schedule('0 10 * * *', () => sendDailySummary('10:00'));
cron.schedule('0 15 * * *', () => sendDailySummary('15:00'));
cron.schedule('0 21 * * *', () => sendDailySummary('21:00'));

// --- НАПОМИНАНИЕ ЗА 30 МИНУТ ДО ДЕДЛАЙНА ---
async function checkDeadlines() {
  const now = new Date();
  const currentHour = now.getHours();
  const currentMinute = now.getMinutes();

  // Считаем время через 30 минут
  const reminderTime = new Date(now.getTime() + 30 * 60 * 1000);
  const reminderHour = reminderTime.getHours();
  const reminderMinute = reminderTime.getMinutes();
  const reminderString = `${String(reminderHour).padStart(2, '0')}:${String(reminderMinute).padStart(2, '0')}`;

  // Ищем задачи с дедлайном через 30 минут, которым ещё не напоминали
  const res = await pool.query(
    'SELECT * FROM tasks WHERE deadline = $1 AND done = FALSE AND reminded = FALSE',
    [reminderString]
  );

  for (const task of res.rows) {
    bot.sendMessage(task.chat_id,
      `🔔 Напоминание! Через 30 минут:\n\n⏰ ${task.text} в ${task.deadline}`
    );
    await pool.query('UPDATE tasks SET reminded = TRUE WHERE id = $1', [task.id]);
  }
}

// Проверяем каждую минуту
cron.schedule('* * * * *', checkDeadlines);

// --- ЗАПУСК ---
initDB().then(() => {
  console.log('Бот запущен! 🚀');
});