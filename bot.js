const { Telegraf } = require('telegraf');
const fs = require('fs');
const https = require('https');

// ─── Проверка переменных окружения ──────────────────────────
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const CODEX_API_KEY = process.env.CODEX_API_KEY;

if (!TELEGRAM_TOKEN) {
  console.error('❌ ОШИБКА: TELEGRAM_TOKEN не установлена!');
  process.exit(1);
}
if (!ANTHROPIC_API_KEY) {
  console.error('❌ ОШИБКА: ANTHROPIC_API_KEY не установлена!');
  process.exit(1);
}
if (!CODEX_API_KEY) {
  console.error('❌ ОШИБКА: CODEX_API_KEY не установлена!');
  process.exit(1);
}

// ─── Настройки ───────────────────────────────────────────────
const ADMIN_ID = parseInt(process.env.ADMIN_ID) || 1151575407666139291;
const REQUESTS_FILE = 'requests.json';
const CLAUDE_MODEL = 'claude-3-5-sonnet-20241022';
const MAX_HISTORY = 20;

// ─── История и данные ────────────────────────────────────────
const chatHistory = new Map();

function getHistory(userId) {
  if (!chatHistory.has(userId)) chatHistory.set(userId, []);
  return chatHistory.get(userId);
}

function addToHistory(userId, role, content) {
  const history = getHistory(userId);
  history.push({ role, content });
  if (history.length > MAX_HISTORY) history.splice(0, history.length - MAX_HISTORY);
}

function clearHistory(userId) {
  chatHistory.set(userId, []);
}

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

// ─── Функция для HTTPS запросов ─────────────────────────────
function httpsRequest(hostname, path, method, headers, data) {
  return new Promise((resolve, reject) => {
    const options = { hostname, path, method, headers };
    const req = https.request(options, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        try {
          resolve(JSON.parse(body));
        } catch (e) {
          reject(new Error(`Parse error: ${e.message}`));
        }
      });
    });
    req.on('error', reject);
    if (data) req.write(JSON.stringify(data));
    req.end();
  });
}

// ─── Claude API ──────────────────────────────────────────────
async function askClaude(messages) {
  try {
    const response = await httpsRequest(
      'api.gngn.my',
      '/v1/messages',
      'POST',
      {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      {
        model: CLAUDE_MODEL,
        max_tokens: 1024,
        messages: messages
      }
    );
    
    return response.content?.[0]?.text || response.message || 'Нет ответа';
  } catch (e) {
    throw new Error(`Claude API: ${e.message}`);
  }
}

// ─── Codex API ──────────────────────────────────────────────
async function askCodex(messages) {
  try {
    const response = await httpsRequest(
      'codex.sale',
      '/v1/chat/completions',
      'POST',
      {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${CODEX_API_KEY}`
      },
      {
        model: 'gpt-3.5-turbo',
        messages: messages,
        max_tokens: 2048
      }
    );
    
    return response.choices?.[0]?.message?.content || 'Нет ответа';
  } catch (e) {
    throw new Error(`Codex API: ${e.message}`);
  }
}

// ─── Telegram Bot ────────────────────────────────────────────
const bot = new Telegraf(TELEGRAM_TOKEN);

// /start
bot.command('start', async (ctx) => {
  const help = `
🤖 *Добро пожаловать!*

Команды:
  • \`/claude вопрос\` - спросить Claude
  • \`/codex вопрос\` - спросить Codex
  • \`/tokens\` - показать запросы
  • \`/cclear\` - очистить историю
  • \`/cgive число userid\` - выдать запросы (админ)

*Примеры:*
  \`/claude Как работает AI?\`
  \`/codex Напиши код для сортировки\`
  `;
  await ctx.reply(help, { parse_mode: 'Markdown' });
});

// /claude
bot.command('claude', async (ctx) => {
  const text = ctx.message.text.replace('/claude', '').trim();
  if (!text) {
    await ctx.reply('❌ Напишите вопрос после `/claude`');
    return;
  }

  const userId = ctx.from.id;
  const remaining = getRequests(userId);

  if (remaining <= 0) {
    await ctx.reply('❌ Запросы закончились. Обратитесь к админу.');
    return;
  }

  setRequests(userId, remaining - 1);
  addToHistory(userId, 'user', text);

  try {
    await ctx.sendChatAction('typing');
    const reply = await askClaude(getHistory(userId));
    addToHistory(userId, 'assistant', reply);
    await ctx.reply(`${reply}\n\n_Осталось: ${remaining - 1}_`, { parse_mode: 'Markdown' });
  } catch (e) {
    console.error(`Claude error: ${e.message}`);
    const history = getHistory(userId);
    if (history.at(-1)?.role === 'user') history.pop();
    setRequests(userId, remaining);
    await ctx.reply(`❌ Ошибка: ${e.message}`, { parse_mode: 'Markdown' });
  }
});

// /codex
bot.command('codex', async (ctx) => {
  const text = ctx.message.text.replace('/codex', '').trim();
  if (!text) {
    await ctx.reply('❌ Напишите вопрос после `/codex`');
    return;
  }

  const userId = ctx.from.id;
  const remaining = getRequests(userId);

  if (remaining <= 0) {
    await ctx.reply('❌ Запросы закончились. Обратитесь к админу.');
    return;
  }

  setRequests(userId, remaining - 1);
  addToHistory(userId, 'user', text);

  try {
    await ctx.sendChatAction('typing');
    const reply = await askCodex(getHistory(userId));
    addToHistory(userId, 'assistant', reply);
    await ctx.reply(`${reply}\n\n_Осталось: ${remaining - 1}_`, { parse_mode: 'Markdown' });
  } catch (e) {
    console.error(`Codex error: ${e.message}`);
    const history = getHistory(userId);
    if (history.at(-1)?.role === 'user') history.pop();
    setRequests(userId, remaining);
    await ctx.reply(`❌ Ошибка: ${e.message}`, { parse_mode: 'Markdown' });
  }
});

// /tokens
bot.command('tokens', async (ctx) => {
  const userId = ctx.from.id;
  const remaining = getRequests(userId);
  await ctx.reply(`🔑 Осталось запросов: *${remaining}*`, { parse_mode: 'Markdown' });
});

// /cclear
bot.command('cclear', async (ctx) => {
  const userId = ctx.from.id;
  clearHistory(userId);
  await ctx.reply('🗑️ История очищена');
});

// /cgive (админ команда)
bot.command('cgive', async (ctx) => {
  const userId = ctx.from.id;
  if (userId !== ADMIN_ID) {
    await ctx.reply('❌ Доступ запрещён');
    return;
  }

  const args = ctx.message.text.split(/\s+/);
  const amount = parseInt(args[1]);
  const targetId = parseInt(args[2]);

  if (!amount || !targetId) {
    await ctx.reply('Использование: `/cgive число userid`', { parse_mode: 'Markdown' });
    return;
  }

  const current = getRequests(targetId);
  setRequests(targetId, current + amount);
  await ctx.reply(`✅ Выдано ${amount} запросов. Всего: ${current + amount}`);
});

// ─── Запуск ──────────────────────────────────────────────────
bot.launch();

console.log('✅ Telegram бот запущен');
console.log(`Model: ${CLAUDE_MODEL}`);
console.log(`Admin ID: ${ADMIN_ID}`);

process.on('SIGINT', () => bot.stop('SIGINT'));
process.on('SIGTERM', () => bot.stop('SIGTERM'));
