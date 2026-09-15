// Stage 4: Connected to Anthropic API — real AI replies, not echo

const { Telegraf } = require('telegraf');
const Anthropic = require('@anthropic-ai/sdk');

const bot = new Telegraf(process.env.BOT_TOKEN);
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

bot.start((ctx) => ctx.reply('Hello! Your AI agent is alive and now connected to Claude. Ask me anything.'));

bot.on('text', async (ctx) => {
  const userMessage = ctx.message.text;

  // Let the user know it's thinking (helps on slower connections)
  await ctx.sendChatAction('typing');

  try {
    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 1000,
      messages: [{ role: 'user', content: userMessage }],
    });

    const reply = response.content
      .filter((block) => block.type === 'text')
      .map((block) => block.text)
      .join('\n');

    ctx.reply(reply || "I didn't get a text response back, try rephrasing.");
  } catch (err) {
    console.error('Anthropic API error:', err);
    ctx.reply('Something went wrong reaching Claude. Check the Shell logs.');
  }
});

bot.launch();
console.log('Bot is running with Anthropic API connected...');

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
