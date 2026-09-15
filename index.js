// Stage 6: Now with memory — stores and recalls conversation history per user

const { Telegraf } = require('telegraf');
const Anthropic = require('@anthropic-ai/sdk');
const http = require('http');
const { Pool } = require('pg');

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

bot.start((ctx) => ctx.reply('Hello! Your AI agent is alive, connected to Claude, and now remembers our conversation. Ask me anything.'));

bot.on('text', async (ctx) => {
  const chatId = String(ctx.chat.id);
  const userMessage = ctx.message.text;
  await ctx.sendChatAction('typing');

  try {
    await saveMessage(chatId, 'user', userMessage);
    const history = await getHistory(chatId, 10);

    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 1000,
      messages: history.map((row) => ({ role: row.role, content: row.content })),
    });

    const reply = response.content
      .filter((block) => block.type === 'text')
      .map((block) => block.text)
      .join('\n');

    await saveMessage(chatId, 'assistant', reply);
    ctx.reply(reply || "I didn't get a text response back, try rephrasing.");
  } catch (err) {
    console.error('Error:', err);
    ctx.reply('Something went wrong. Check the logs.');
  }
});

setupDatabase().then(() => {
  bot.launch();
  console.log('Bot is running with Anthropic API and database connected...');
});

const PORT = process.env.PORT || 3000;
http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('Bot is alive');
}).listen(PORT, () => console.log(`Health check server on port ${PORT}`));

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
