// Stage 11: Adds Bybit price checks — /price <symbol>
// (all slash commands are registered before the general text handler,
// so they get matched correctly instead of falling through to Claude)

const { Telegraf } = require('telegraf');
const Anthropic = require('@anthropic-ai/sdk');
const http = require('http');
const { Pool } = require('pg');
const mammoth = require('mammoth');

const bot = new Telegraf(process.env.BOT_TOKEN);
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

async function setupDatabase() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS conversations (
      id SERIAL PRIMARY KEY,
      chat_id TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at TIMESTAMP DEFAULT NOW()
    );
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS reminders (
      id SERIAL PRIMARY KEY,
      chat_id TEXT NOT NULL,
      message TEXT NOT NULL,
      remind_at TIMESTAMP NOT NULL,
      sent BOOLEAN DEFAULT FALSE,
      created_at TIMESTAMP DEFAULT NOW()
    );
  `);
  console.log('Database ready.');
}

async function saveMessage(chatId, role, content) {
  await pool.query(
    'INSERT INTO conversations (chat_id, role, content) VALUES ($1, $2, $3)',
    [chatId, role, content]
  );
}

async function getHistory(chatId, limit = 10) {
  const result = await pool.query(
    'SELECT role, content FROM conversations WHERE chat_id = $1 ORDER BY id DESC LIMIT $2',
    [chatId, limit]
  );
  return result.rows.reverse();
}

async function askClaude(messages) {
  const response = await anthropic.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 1000,
    messages,
  });
  return response.content
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('\n');
}

bot.start((ctx) => ctx.reply(
  "Hello! Your AI agent is alive, remembers our chat, and can:\n" +
  "- Summarize .docx documents you send\n" +
  "- Set reminders: /remind <minutes> <message>\n" +
  "  e.g. /remind 30 Call the printing vendor\n" +
  "- List reminders: /reminders\n" +
  "- Check crypto prices: /price <symbol>\n" +
  "  e.g. /price SOLUSDT\n" +
  "Ask me anything else too."
));

// ---- All slash commands go here, BEFORE the general text handler ----

bot.command('remind', async (ctx) => {
  const chatId = String(ctx.chat.id);
  const parts = ctx.message.text.split(' ').slice(1);
  const minutes = parseInt(parts[0], 10);
  const message = parts.slice(1).join(' ');

  if (!minutes || !message) {
    return ctx.reply('Usage: /remind <minutes> <message>\nExample: /remind 30 Call the printing vendor');
  }

  const remindAt = new Date(Date.now() + minutes * 60 * 1000);

  await pool.query(
    'INSERT INTO reminders (chat_id, message, remind_at) VALUES ($1, $2, $3)',
    [chatId, message, remindAt]
  );

  ctx.reply(`Got it — I'll remind you in ${minutes} minute(s): "${message}"`);
});

bot.command('reminders', async (ctx) => {
  const chatId = String(ctx.chat.id);
  const result = await pool.query(
    'SELECT message, remind_at FROM reminders WHERE chat_id = $1 AND sent = FALSE ORDER BY remind_at ASC',
    [chatId]
  );

  if (result.rows.length === 0) {
    return ctx.reply('You have no pending reminders.');
  }

  const list = result.rows
    .map((r) => `- ${r.message} (at ${new Date(r.remind_at).toLocaleString()})`)
    .join('\n');
  ctx.reply(`Your pending reminders:\n${list}`);
});

// /price <symbol> - fetch live price from Bybit public API (no API key needed)
bot.command('price', async (ctx) => {
  const parts = ctx.message.text.split(' ').slice(1);
  const symbol = (parts[0] || '').toUpperCase();

  if (!symbol) {
    return ctx.reply('Usage: /price <symbol>\nExample: /price SOLUSDT');
  }

  try {
    const url = `https://api.bybit.com/v5/market/tickers?category=linear&symbol=${symbol}`;
    const response = await fetch(url);
    const data = await response.json();

    if (data.retCode !== 0 || !data.result?.list?.length) {
      return ctx.reply(`Couldn't find data for "${symbol}". Check the symbol is correct, e.g. SOLUSDT, BTCUSDT.`);
    }

    const ticker = data.result.list[0];
    const changePct = (parseFloat(ticker.price24hPcnt) * 100).toFixed(2);
    const direction = changePct >= 0 ? '📈' : '📉';

    ctx.reply(
      `${symbol} — $${ticker.lastPrice}\n` +
      `${direction} 24h change: ${changePct}%\n` +
      `24h high: $${ticker.highPrice24h}\n` +
      `24h low: $${ticker.lowPrice24h}\n` +
      `24h volume: ${ticker.volume24h}`
    );
  } catch (err) {
    console.error('Bybit price fetch error:', err);
    ctx.reply('Something went wrong fetching that price. Try again shortly.');
  }
});

// ---- Reminder background checker ----

async function checkReminders() {
  try {
    const due = await pool.query(
      'SELECT id, chat_id, message FROM reminders WHERE sent = FALSE AND remind_at <= NOW()'
    );
    for (const reminder of due.rows) {
      try {
        await bot.telegram.sendMessage(reminder.chat_id, `⏰ Reminder: ${reminder.message}`);
        await pool.query('UPDATE reminders SET sent = TRUE WHERE id = $1', [reminder.id]);
      } catch (sendErr) {
        console.error('Failed to send one reminder:', sendErr);
      }
    }
  } catch (err) {
    console.error('Reminder check error:', err);
  }
}
setInterval(checkReminders, 30 * 1000);

// ---- General text handler (must come AFTER all commands above) ----

bot.on('text', async (ctx) => {
  const chatId = String(ctx.chat.id);
  const userMessage = ctx.message.text;

  try {
    await ctx.sendChatAction('typing');
    await saveMessage(chatId, 'user', userMessage);
    const history = await getHistory(chatId, 10);
    const reply = await askClaude(history.map((row) => ({ role: row.role, content: row.content })));
    await saveMessage(chatId, 'assistant', reply);
    await ctx.reply(reply || "I didn't get a text response back, try rephrasing.");
  } catch (err) {
    console.error('Text handler error:', err);
    try {
      await ctx.reply('Something went wrong on my end — try again in a moment.');
    } catch (replyErr) {
      console.error('Could not even send the error message:', replyErr);
    }
  }
});

bot.on('document', async (ctx) => {
  const chatId = String(ctx.chat.id);
  const fileName = ctx.message.document.file_name || '';

  if (!fileName.toLowerCase().endsWith('.docx')) {
    return ctx.reply('For now I can only read .docx Word documents. PDF support is coming later.');
  }

  try {
    await ctx.reply('Got your document — reading it now...');
    await ctx.sendChatAction('typing');

    const fileLink = await ctx.telegram.getFileLink(ctx.message.document.file_id);
    const response = await fetch(fileLink.href);
    const arrayBuffer = await response.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    const { value: extractedText } = await mammoth.extractRawText({ buffer });
    const trimmedText = extractedText.slice(0, 15000);

    const summary = await askClaude([
      {
        role: 'user',
        content: `Summarize the following document. Give the title/topic, then key points as a short list, and a one-line takeaway.\n\nDocument:\n${trimmedText}`,
      },
    ]);

    await saveMessage(chatId, 'user', `[Uploaded document: ${fileName}]`);
    await saveMessage(chatId, 'assistant', summary);

    await ctx.reply(summary);
  } catch (err) {
    console.error('Document processing error:', err);
    try {
      await ctx.reply('Something went wrong reading that document. Make sure it is a valid .docx file.');
    } catch (replyErr) {
      console.error('Could not even send the error message:', replyErr);
    }
  }
});

// Catch-all: log any error Telegraf itself surfaces, without crashing
bot.catch((err, ctx) => {
  console.error(`Unhandled bot error for update ${ctx.updateType}:`, err);
});

process.on('unhandledRejection', (reason) => {
  console.error('Unhandled promise rejection:', reason);
});
process.on('uncaughtException', (err) => {
  console.error('Uncaught exception:', err);
});

setupDatabase().then(() => {
  bot.launch();
  console.log('Bot is running with Anthropic API, database, document summarization, reminders, and crypto prices...');
});

const PORT = process.env.PORT || 3000;
http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('Bot is alive');
}).listen(PORT, () => console.log(`Health check server on port ${PORT}`));

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
