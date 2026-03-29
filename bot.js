require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const cron = require('node-cron');
const fs = require('fs');

// --- НАСТРОЙКИ ---
const TOKEN = process.env.TOKEN;
const CHAT_ID_FILE = 'chat_id.txt';
const TASKS_FILE = 'tasks.json';

// --- ИНИЦИАЛИЗАЦИЯ БОТА ---
const bot = new TelegramBot(TOKEN, { polling: true });

// --- ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ ---
function loadTasks() {
  if (!fs.existsSync(TASKS_FILE)) return [];
  return JSON.parse(fs.readFileSync(TASKS_FILE, 'utf8'));
}

function saveTasks(tasks) {
  fs.writeFileSync(TASKS_FILE, JSON.stringify(tasks, null, 2));
}

function saveChatId(chatId) {
  fs.writeFileSync(CHAT_ID_FILE, String(chatId));
}

function loadChatId() {
  if (!fs.existsSync(CHAT_ID_FILE)) return null;
  return fs.readFileSync(CHAT_ID_FILE, 'utf8').trim();
}

// --- КОМАНДЫ БОТА ---

// /start — приветствие
bot.onText(/\/start/, (msg) => {
  saveChatId(msg.chat.id);
  bot.sendMessage(msg.chat.id,
    '👋 Привет! Я твой Todo-бот.\n\n' +
    'Команды:\n' +
    '/add Текст задачи — добавить задачу\n' +
    '/list — показать все задачи\n' +
    '/clear — удалить все выполненные задачи'
  );
});

// /add — добавить задачу
bot.onText(/\/add (.+)/, (msg, match) => {
  saveChatId(msg.chat.id);
  const tasks = loadTasks();
  const newTask = {
    id: Date.now(),
    text: match[1],
    done: false
  };
  tasks.push(newTask);
  saveTasks(tasks);
  bot.sendMessage(msg.chat.id, `✅ Задача добавлена: "${newTask.text}"`);
});

// /list — показать задачи с кнопками
bot.onText(/\/list/, (msg) => {
  saveChatId(msg.chat.id);
  const tasks = loadTasks();
  if (tasks.length === 0) {
    bot.sendMessage(msg.chat.id, '📭 Список задач пуст. Добавь задачу через /add');
    return;
  }
  tasks.forEach((task) => {
    const status = task.done ? '✅' : '🔲';
    const buttons = task.done
      ? []
      : [[{ text: '✅ Выполнено', callback_data: `done_${task.id}` }]];
    bot.sendMessage(msg.chat.id, `${status} ${task.text}`, {
      reply_markup: { inline_keyboard: buttons }
    });
  });
});

// /clear — удалить выполненные задачи
bot.onText(/\/clear/, (msg) => {
  const tasks = loadTasks().filter(t => !t.done);
  saveTasks(tasks);
  bot.sendMessage(msg.chat.id, '🗑️ Выполненные задачи удалены.');
});

// Нажатие кнопки "Выполнено"
bot.on('callback_query', (query) => {
  const taskId = parseInt(query.data.replace('done_', ''));
  const tasks = loadTasks();
  const task = tasks.find(t => t.id === taskId);
  if (task) {
    task.done = true;
    saveTasks(tasks);
    bot.editMessageText(`✅ Выполнено: ${task.text}`, {
      chat_id: query.message.chat.id,
      message_id: query.message.message_id
    });
  }
  bot.answerCallbackQuery(query.id);
});

// --- НАПОМИНАНИЯ (10:00, 14:00, 19:00) ---
function sendReminder() {
  const chatId = loadChatId();
  if (!chatId) return;
  const tasks = loadTasks().filter(t => !t.done);
  if (tasks.length === 0) return;
  const list = tasks.map(t => `🔲 ${t.text}`).join('\n');
  bot.sendMessage(chatId, `⏰ Напоминание! Незавершённые задачи:\n\n${list}`);
}

cron.schedule('0 10 * * *', sendReminder); // 10:00
cron.schedule('0 14 * * *', sendReminder); // 14:00
cron.schedule('0 19 * * *', sendReminder); // 19:00

console.log('Бот запущен! 🚀');