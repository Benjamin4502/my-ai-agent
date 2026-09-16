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
  await pool.query(`
    CREATE TABLE IF NOT EXISTS alert_subscribers (
      chat_id TEXT PRIMARY KEY,
      created_at TIMESTAMP DEFAULT NOW()
    );
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS alert_state (
      symbol TEXT PRIMARY KEY,
      zone TEXT NOT NULL DEFAULT 'neutral',
      updated_at TIMESTAMP DEFAULT NOW()
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
  "- Get a basic technical signal: /signal <symbol>\n" +
  "  e.g. /signal SOL\n" +
  "- Turn on watchlist alerts: /alertson (off: /alertsoff)\n" +
  "- See the watchlist: /watchlist\n" +
  "- Backtest a strategy: /backtest <symbol> [days]\n" +
  "  e.g. /backtest SOL 90\n" +
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
// A small lookup for common tickers -> CoinGecko IDs
const COINGECKO_IDS = {
  BTC: 'bitcoin', ETH: 'ethereum', SOL: 'solana', BNB: 'binancecoin',
  XRP: 'ripple', DOGE: 'dogecoin', ADA: 'cardano', TON: 'the-open-network',
  TRX: 'tron', LINK: 'chainlink', AVAX: 'avalanche-2', MATIC: 'matic-network',
  DOT: 'polkadot', LTC: 'litecoin', SHIB: 'shiba-inu', NOM: 'onomy-protocol',
  MYX: 'myx-finance',
};

async function resolveCoinGeckoId(base) {
  if (COINGECKO_IDS[base]) return COINGECKO_IDS[base];
  // Fallback: search CoinGecko directly for anything not in our shortlist
  const searchRes = await fetch(`https://api.coingecko.com/api/v3/search?query=${base}`);
  const searchData = await searchRes.json();
  const match = searchData.coins?.find((c) => c.symbol.toUpperCase() === base);
  return match ? match.id : null;
}

// /price <symbol> - fetch live price from CoinGecko's public API (no key, no region blocks)
bot.command('price', async (ctx) => {
  const parts = ctx.message.text.split(' ').slice(1);
  let symbol = (parts[0] || '').toUpperCase();

  if (!symbol) {
    return ctx.reply('Usage: /price <symbol>\nExample: /price SOL or /price SOLUSDT');
  }

  const base = symbol.endsWith('USDT') ? symbol.slice(0, -4) : symbol;

  try {
    const coinId = await resolveCoinGeckoId(base);
    if (!coinId) {
      return ctx.reply(`Couldn't find data for "${symbol}". Try just the coin symbol, e.g. /price SOL`);
    }

    const url = `https://api.coingecko.com/api/v3/simple/price?ids=${coinId}&vs_currencies=usd&include_24hr_change=true&include_24hr_vol=true&include_market_cap=true`;
    const response = await fetch(url);
    const data = await response.json();
    const info = data[coinId];

    if (!info) {
      return ctx.reply(`Couldn't find price data for "${symbol}" right now.`);
    }

    const changePct = info.usd_24h_change?.toFixed(2) ?? 'N/A';
    const direction = (info.usd_24h_change ?? 0) >= 0 ? '📈' : '📉';

    ctx.reply(
      `${base} — $${info.usd.toLocaleString()}\n` +
      `${direction} 24h change: ${changePct}%\n` +
      `24h volume: $${Math.round(info.usd_24h_vol).toLocaleString()}\n` +
      `Market cap: $${Math.round(info.usd_market_cap).toLocaleString()}`
    );
  } catch (err) {
    console.error('CoinGecko price fetch error:', err);
    ctx.reply('Something went wrong fetching that price. Try again shortly.');
  }
});

// Calculates RSI (Relative Strength Index) from an array of closing prices.
// Standard 14-period RSI: measures average gains vs average losses.
function calculateRSI(closes, period = 14) {
  if (closes.length < period + 1) return null;

  let gains = 0;
  let losses = 0;
  for (let i = 1; i <= period; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff >= 0) gains += diff;
    else losses -= diff;
  }
  let avgGain = gains / period;
  let avgLoss = losses / period;

  for (let i = period + 1; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    const gain = diff > 0 ? diff : 0;
    const loss = diff < 0 ? -diff : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
  }

  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

function interpretRSI(rsi) {
  if (rsi === null) return 'Not enough data to calculate RSI yet.';
  if (rsi >= 70) return `RSI ${rsi.toFixed(1)} — Overbought zone. Often a caution sign, price may be due to cool off.`;
  if (rsi <= 30) return `RSI ${rsi.toFixed(1)} — Oversold zone. Sometimes seen as a potential buy zone, but confirm with other signals.`;
  return `RSI ${rsi.toFixed(1)} — Neutral zone. No strong overbought/oversold signal right now.`;
}

// /signal <symbol> - basic technical read using RSI(14) on daily closes
bot.command('signal', async (ctx) => {
  const parts = ctx.message.text.split(' ').slice(1);
  const symbol = (parts[0] || '').toUpperCase();

  if (!symbol) {
    return ctx.reply('Usage: /signal <symbol>\nExample: /signal SOL or /signal BTC');
  }

  const base = symbol.endsWith('USDT') ? symbol.slice(0, -4) : symbol;

  try {
    const coinId = await resolveCoinGeckoId(base);
    if (!coinId) {
      return ctx.reply(`Couldn't find data for "${symbol}". Try just the coin symbol, e.g. /signal SOL`);
    }

    const url = `https://api.coingecko.com/api/v3/coins/${coinId}/market_chart?vs_currency=usd&days=30&interval=daily`;
    const response = await fetch(url);
    const data = await response.json();

    if (!data.prices || data.prices.length < 15) {
      return ctx.reply(`Not enough price history for "${symbol}" to calculate a signal yet.`);
    }

    const closes = data.prices.map((p) => p[1]);
    const currentPrice = closes[closes.length - 1];
    const rsi = calculateRSI(closes, 14);

    ctx.reply(
      `📊 Signal for ${base}\n\n` +
      `Current price: $${currentPrice.toLocaleString()}\n` +
      `${interpretRSI(rsi)}\n\n` +
      `⚠️ This is a basic technical read, not financial advice. Always confirm with your own research before acting.`
    );
  } catch (err) {
    console.error('Signal calculation error:', err);
    ctx.reply('Something went wrong calculating that signal. Try again shortly.');
  }
});

// Same math as calculateRSI, but returns the RSI value at EVERY point in time
// (needed for backtesting, since we need to know RSI on each historical day)
function calculateRSISeries(closes, period = 14) {
  const series = new Array(closes.length).fill(null);
  if (closes.length < period + 1) return series;

  let gains = 0;
  let losses = 0;
  for (let i = 1; i <= period; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff >= 0) gains += diff;
    else losses -= diff;
  }
  let avgGain = gains / period;
  let avgLoss = losses / period;
  series[period] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);

  for (let i = period + 1; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    const gain = diff > 0 ? diff : 0;
    const loss = diff < 0 ? -diff : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
    series[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  }
  return series;
}

// /backtest <symbol> [days] - simulate "buy at oversold, sell at overbought" historically
bot.command('backtest', async (ctx) => {
  const parts = ctx.message.text.split(' ').slice(1);
  const symbol = (parts[0] || '').toUpperCase();
  const days = Math.min(parseInt(parts[1], 10) || 90, 365);

  if (!symbol) {
    return ctx.reply('Usage: /backtest <symbol> [days]\nExample: /backtest SOL 90');
  }

  const base = symbol.endsWith('USDT') ? symbol.slice(0, -4) : symbol;

  try {
    await ctx.reply(`Backtesting ${base} over the last ${days} days...`);

    const coinId = await resolveCoinGeckoId(base);
    if (!coinId) {
      return ctx.reply(`Couldn't find data for "${symbol}".`);
    }

    const url = `https://api.coingecko.com/api/v3/coins/${coinId}/market_chart?vs_currency=usd&days=${days}&interval=daily`;
    const response = await fetch(url);
    const data = await response.json();

    if (!data.prices || data.prices.length < 20) {
      return ctx.reply(`Not enough price history for "${symbol}" over ${days} days.`);
    }

    const closes = data.prices.map((p) => p[1]);
    const rsiSeries = calculateRSISeries(closes, 14);

    let position = null; // { entryPrice }
    const trades = [];

    for (let i = 1; i < closes.length; i++) {
      const rsi = rsiSeries[i];
      const prevRsi = rsiSeries[i - 1];
      if (rsi === null || prevRsi === null) continue;

      // Enter: RSI crosses down into oversold (<=30) while flat
      if (!position && prevRsi > 30 && rsi <= 30) {
        position = { entryPrice: closes[i], entryIndex: i };
      }
      // Exit: RSI crosses up into overbought (>=70) while holding
      else if (position && prevRsi < 70 && rsi >= 70) {
        const exitPrice = closes[i];
        const returnPct = ((exitPrice - position.entryPrice) / position.entryPrice) * 100;
        trades.push(returnPct);
        position = null;
      }
    }

    let openNote = '';
    if (position) {
      const unrealizedPct = ((closes[closes.length - 1] - position.entryPrice) / position.entryPrice) * 100;
      openNote = `\n(Still holding an open position from this strategy: ${unrealizedPct >= 0 ? '+' : ''}${unrealizedPct.toFixed(2)}% unrealized)`;
    }

    if (trades.length === 0) {
      return ctx.reply(`No completed buy/sell cycles for ${base} in the last ${days} days using this RSI strategy.${openNote}\n\n⚠️ Not financial advice — a backtest on limited history doesn't guarantee future results.`);
    }

    const wins = trades.filter((t) => t > 0).length;
    const winRate = ((wins / trades.length) * 100).toFixed(1);
    const totalReturn = trades.reduce((sum, t) => sum + t, 0);
    const avgReturn = (totalReturn / trades.length).toFixed(2);

    ctx.reply(
      `📊 Backtest: ${base} — RSI(14) oversold/overbought strategy, last ${days} days\n\n` +
      `Completed trades: ${trades.length}\n` +
      `Win rate: ${winRate}% (${wins}/${trades.length})\n` +
      `Total return (summed): ${totalReturn >= 0 ? '+' : ''}${totalReturn.toFixed(2)}%\n` +
      `Average return per trade: ${avgReturn >= 0 ? '+' : ''}${avgReturn}%` +
      openNote +
      `\n\n⚠️ This is a simplified backtest (no fees/slippage included) on limited history — not financial advice, and past results don't guarantee future ones.`
    );
  } catch (err) {
    console.error('Backtest error:', err);
    ctx.reply('Something went wrong running that backtest. Try again shortly.');
  }
});

// ---- Automatic watchlist alerts (Stage 13) ----

const WATCHLIST = ['SOL', 'NOM', 'MYX'];

bot.command('alertson', async (ctx) => {
  const chatId = String(ctx.chat.id);
  await pool.query(
    'INSERT INTO alert_subscribers (chat_id) VALUES ($1) ON CONFLICT (chat_id) DO NOTHING',
    [chatId]
  );
  ctx.reply(`Alerts turned on ✅\nWatching: ${WATCHLIST.join(', ')}\nYou'll get a message when any of these enter overbought or oversold territory.`);
});

bot.command('alertsoff', async (ctx) => {
  const chatId = String(ctx.chat.id);
  await pool.query('DELETE FROM alert_subscribers WHERE chat_id = $1', [chatId]);
  ctx.reply('Alerts turned off. You can turn them back on anytime with /alertson.');
});

bot.command('watchlist', async (ctx) => {
  ctx.reply(`Current auto-watchlist: ${WATCHLIST.join(', ')}`);
});

function zoneForRSI(rsi) {
  if (rsi === null) return 'neutral';
  if (rsi >= 70) return 'overbought';
  if (rsi <= 30) return 'oversold';
  return 'neutral';
}

async function checkWatchlistAlerts() {
  try {
    const subs = await pool.query('SELECT chat_id FROM alert_subscribers');
    if (subs.rows.length === 0) return; // nobody subscribed, skip the work

    for (const base of WATCHLIST) {
      try {
        const coinId = await resolveCoinGeckoId(base);
        if (!coinId) continue;

        const url = `https://api.coingecko.com/api/v3/coins/${coinId}/market_chart?vs_currency=usd&days=30&interval=daily`;
        const response = await fetch(url);
        const data = await response.json();
        if (!data.prices || data.prices.length < 15) continue;

        const closes = data.prices.map((p) => p[1]);
        const currentPrice = closes[closes.length - 1];
        const rsi = calculateRSI(closes, 14);
        const newZone = zoneForRSI(rsi);

        const stateResult = await pool.query('SELECT zone FROM alert_state WHERE symbol = $1', [base]);
        const oldZone = stateResult.rows[0]?.zone ?? 'neutral';

        // Only alert when actually crossing INTO overbought/oversold, not every check
        if (newZone !== oldZone && (newZone === 'overbought' || newZone === 'oversold')) {
          const message =
            `🔔 Watchlist alert: ${base}\n` +
            `Price: $${currentPrice.toLocaleString()}\n` +
            `${interpretRSI(rsi)}`;

          for (const sub of subs.rows) {
            try {
              await bot.telegram.sendMessage(sub.chat_id, message);
            } catch (sendErr) {
              console.error(`Failed to send alert to ${sub.chat_id}:`, sendErr);
            }
          }
        }

        await pool.query(
          `INSERT INTO alert_state (symbol, zone, updated_at) VALUES ($1, $2, NOW())
           ON CONFLICT (symbol) DO UPDATE SET zone = $2, updated_at = NOW()`,
          [base, newZone]
        );
      } catch (coinErr) {
        console.error(`Watchlist check failed for ${base}:`, coinErr);
      }
    }
  } catch (err) {
    console.error('Watchlist alert check error:', err);
  }
}
setInterval(checkWatchlistAlerts, 30 * 60 * 1000); // every 30 minutes

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
