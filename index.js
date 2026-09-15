// Stage 8: Adds document summarization — send the bot a .docx file, it replies with a summary

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

bot.start((ctx) => ctx.reply('Hello! Your AI agent is alive, remembers our chat, and can now summarize documents. Send me a question or a .docx file.'));

// Handle plain text messages (existing behavior)
bot.on('text', async (ctx) => {
  const chatId = String(ctx.chat.id);
  const userMessage = ctx.message.text;
  await ctx.sendChatAction('typing');

  try {
    await saveMessage(chatId, 'user', userMessage);
    const history = await getHistory(chatId, 10);
    const reply = await askClaude(history.map((row) => ({ role: row.role, content: row.content })));
    await saveMessage(chatId, 'assistant', reply);
    ctx.reply(reply || "I didn't get a text response back, try rephrasing.");
  } catch (err) {
    console.error('Error:', err);
    ctx.reply('Something went wrong. Check the logs.');
  }
});

// Handle uploaded documents (.docx summarization)
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

    // Keep prompts a reasonable size
    const trimmedText = extractedText.slice(0, 15000);

    const summary = await askClaude([
      {
        role: 'user',
        content: `Summarize the following document. Give the title/topic, then key points as a short list, and a one-line takeaway.\n\nDocument:\n${trimmedText}`,
      },
    ]);

    await saveMessage(chatId, 'user', `[Uploaded document: ${fileName}]`);
    await saveMessage(chatId, 'assistant', summary);

    ctx.reply(summary);
  } catch (err) {
    console.error('Document processing error:', err);
    ctx.reply('Something went wrong reading that document. Make sure it is a valid .docx file.');
  }
});

setupDatabase().then(() => {
  bot.launch();
  console.log('Bot is running with Anthropic API, database, and document summarization...');
});

const PORT = process.env.PORT || 3000;
http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('Bot is alive');
}).listen(PORT, () => console.log(`Health check server on port ${PORT}`));

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
