const { Telegraf } = require('telegraf');
const Anthropic = require('@anthropic-ai/sdk');
const OpenAI = require('openai');
const fs = require('fs');

// ─── Настройки ───────────────────────────────────────────────
const ADMIN_ID = 1151575407666139291; // Замени на свой Telegram ID
const REQUESTS_FILE = 'requests.json';
const CLAUDE_MODEL = 'claude-3-5-sonnet-20241022'; // Дешевле чем 4.7!
const CODEX_MODEL = 'gpt-5.5';
const MAX_HISTORY = 20;

// ─── История чатов (в памяти) ────────────────────────────────
const chatHistory = new Map();

function getHistory(userId) {
  if (!chatHistory.has(userId)) chatHistory.set(userId, []);
  return chatHistory.get(userId);
}

function addToHistory(userId, role, content) {
  const history = getHistory(userId);
  history.push({ role, content });
  if (history.length > MAX_HISTORY) {
    history.splice(0, history.length - MAX_HISTORY);
  }
}

function clearHistory(userId) {
  chatHistory.set(userId, []);
}

// ─── Загрузка/сохранение запросов ────────────────────────────
function loadRequests() {
  if (!fs.existsSync(REQUESTS_FILE)) fs.writeFileSync(REQUESTS_FILE, JSON.stringify({}));
  return JSON.parse(fs.readFileSync(REQUESTS_FILE, 'utf8'));
}

function saveRequests(data) {
  fs.writeFileSync(REQUESTS_FILE, JSON.stringify(data, null, 2));
}

function getRequests(userId) {
  return loadRequests()[userId] ?? 0;
}

function setRequests(userId, count) {
  const data = loadRequests();
  data[userId] = count;
  saveRequests(data);
}

// ─── Разбивка длинного текста на части ───────────────────────
function splitMessage(text, maxLength = 4000) {
  const parts = [];
  while (text.length > 0) {
    if (text.length <= maxLength) {
      parts.push(text);
      break;
    }
    let splitAt = text.lastIndexOf('\n', maxLength);
    if (splitAt === -1) splitAt = maxLength;
    parts.push(text.slice(0, splitAt));
    text = text.slice(splitAt).trimStart();
  }
  return parts;
}

// ─── Универсальная отправка ответа ───────────────────────────
async function sendReply(ctx, reply, remaining) {
  const footer = `\n\n_Осталось запросов: *${remaining}*_`;
  const fullReply = reply + footer;
  
  if (fullReply.length > 4000) {
    const parts = splitMessage(reply);
    for (let i = 0; i < parts.length; i++) {
      const isLast = i === parts.length - 1;
      const text = parts[i] + (isLast ? footer : '');
      if (i === 0) {
        await ctx.reply(text, { parse_mode: 'Markdown' });
      } else {
        await ctx.telegram.sendMessage(ctx.chat.id, text, { parse_mode: 'Markdown' });
      }
    }
  } else {
    await ctx.reply(fullReply, { parse_mode: 'Markdown' });
  }
}

// ─── Клиенты ─────────────────────────────────────────────────
const bot = new Telegraf(process.env.TELEGRAM_TOKEN);

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
  baseURL: 'https://api.gngn.my',
});

const codex = new OpenAI({
  apiKey: process.env.CODEX_API_KEY,
  baseURL: 'https://codex.sale/v1',
});

// ─── Обработка команд ────────────────────────────────────────

// /claude <вопрос>
bot.command('claude', async (ctx) => {
  const text = ctx.message.text.replace('/claude', '').trim();

  if (!text) {
    await ctx.reply('❌ Напишите вопрос после `/claude`.');
    return;
  }

  const userId = ctx.from.id;
  const remaining = getRequests(userId);

  if (remaining <= 0) {
    await ctx.reply('❌ У вас закончились запросы. Обратитесь к администратору.');
    return;
  }

  setRequests(userId, remaining - 1);
  addToHistory(userId, 'user', text);

  try {
    await ctx.sendChatAction('typing');

    const stream = await anthropic.messages.stream({
      model: CLAUDE_MODEL,
      max_tokens: 2048,
      messages: getHistory(userId),
    });

    const response = await stream.finalMessage();
    const reply = response.content[0].text;
    addToHistory(userId, 'assistant', reply);
    await sendReply(ctx, reply, remaining - 1);
  } catch (e) {
    log('ERROR', `Claude API error: ${e.constructor.name}: ${e.message}`);
    const history = getHistory(userId);
    if (history.at(-1)?.role === 'user') history.pop();
    setRequests(userId, remaining);
    await ctx.reply(`❌ Ошибка Claude: \`${e.constructor.name}: ${String(e.message).slice(0, 200)}\``, {
      parse_mode: 'Markdown',
    });
  }
});

// /codex <вопрос>
bot.command('codex', async (ctx) => {
  const text = ctx.message.text.replace('/codex', '').trim();

  if (!text) {
    await ctx.reply('❌ Напишите вопрос после `/codex`.');
    return;
  }

  const userId = ctx.from.id;
  const remaining = getRequests(userId);

  if (remaining <= 0) {
    await ctx.reply('❌ У вас закончились запросы. Обратитесь к администратору.');
    return;
  }

  setRequests(userId, remaining - 1);
  addToHistory(userId, 'user', text);

  try {
    await ctx.sendChatAction('typing');

    const response = await codex.chat.completions.create({
      model: CODEX_MODEL,
      messages: getHistory(userId),
      max_tokens: 4096,
    });

    const reply = response.choices[0].message.content;
    addToHistory(userId, 'assistant', reply);
    await sendReply(ctx, reply, remaining - 1);
  } catch (e) {
    log('ERROR', `Codex API error: ${e.constructor.name}: ${e.message}`);
    const history = getHistory(userId);
    if (history.at(-1)?.role === 'user') history.pop();
    setRequests(userId, remaining);
    await ctx.reply(`❌ Ошибка Codex: \`${e.constructor.name}: ${String(e.message).slice(0, 200)}\``, {
      parse_mode: 'Markdown',
    });
  }
});

// /tokens - показать количество запросов
bot.command('tokens', async (ctx) => {
  const userId = ctx.from.id;
  const remaining = getRequests(userId);
  await ctx.reply(`🔑 У вас осталось *${remaining}* запросов.`, { parse_mode: 'Markdown' });
});

// /cclear - очистить историю
bot.command('cclear', async (ctx) => {
  const userId = ctx.from.id;
  clearHistory(userId);
  await ctx.reply('🗑️ История вашего чата очищена.');
});

// /cgive <число> - выдать запросы (только админ)
bot.command('cgive', async (ctx) => {
  const userId = ctx.from.id;

  if (userId !== ADMIN_ID) {
    await ctx.reply('❌ У вас нет доступа к этой команде.');
    return;
  }

  const parts = ctx.message.text.split(/\s+/);
  const amount = parseInt(parts[1]);

  if (!amount || amount <= 0) {
    await ctx.reply('❌ Укажите корректное число запросов.\n\nИспользование: `/cgive <число> <user_id>`', {
      parse_mode: 'Markdown',
    });
    return;
  }

  const targetId = parseInt(parts[2]);
  if (!targetId) {
    await ctx.reply('❌ Укажите ID пользователя.\n\nИспользование: `/cgive <число> <user_id>`', {
      parse_mode: 'Markdown',
    });
    return;
  }

  const current = getRequests(targetId);
  setRequests(targetId, current + amount);

  await ctx.reply(`✅ Пользователю \`${targetId}\` выдано *${amount}* запросов. Всего: *${current + amount}*`, {
    parse_mode: 'Markdown',
  });
});

// /start - справка
bot.command('start', async (ctx) => {
  const helpText = `
🤖 *Добро пожаловать!*

Доступные команды:
  • \`/claude <вопрос>\` - спросить Claude (3.5 Sonnet)
  • \`/codex <вопрос>\` - спросить Codex
  • \`/tokens\` - показать оставшиеся запросы
  • \`/cclear\` - очистить историю чата

*Примеры:*
  \`/claude Как работает машинное обучение?\`
  \`/codex Напиши код для сортировки массива\`
  `;
  await ctx.reply(helpText, { parse_mode: 'Markdown' });
});

// ─── Логирование ─────────────────────────────────────────────
function log(level, message) {
  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}] [${level}] ${message}`);
}

// ─── Запуск ──────────────────────────────────────────────────
bot.launch();

log('INFO', '✅ Telegram бот запущен');
log('INFO', `Claude Model: ${CLAUDE_MODEL}`);
log('INFO', `Codex Model: ${CODEX_MODEL}`);
log('INFO', `Admin ID: ${ADMIN_ID}`);
log('INFO', `Environment: ${process.env.NODE_ENV || 'production'}`);

// ─── Обработка сигналов ──────────────────────────────────────
process.once('SIGINT', () => {
  log('WARN', 'SIGINT получен - остановка бота');
  bot.stop('SIGINT');
});

process.once('SIGTERM', () => {
  log('WARN', 'SIGTERM получен - остановка бота');
  bot.stop('SIGTERM');
});

// ─── Обработка необработанных ошибок ─────────────────────────
process.on('unhandledRejection', (reason, promise) => {
  log('ERROR', `Необработанное отклонение: ${reason}`);
  console.error(promise);
});

process.on('uncaughtException', (error) => {
  log('ERROR', `Необработанное исключение: ${error.message}`);
  console.error(error);
});
