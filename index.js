// Stage 11: Adds Bybit price checks — /price <symbol>
// (all slash commands are registered before the general text handler,
// so they get matched correctly instead of falling through to Claude)

const { Telegraf, Markup } = require('telegraf');
const Anthropic = require('@anthropic-ai/sdk');
const http = require('http');
const { Pool } = require('pg');
const mammoth = require('mammoth');
const crypto = require('crypto');

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
  await pool.query(`
    CREATE TABLE IF NOT EXISTS trade_suggestions (
      id SERIAL PRIMARY KEY,
      chat_id TEXT NOT NULL,
      symbol TEXT NOT NULL,
      target_pct INTEGER NOT NULL,
      stop_loss_pct INTEGER NOT NULL DEFAULT 50,
      leverage INTEGER NOT NULL DEFAULT 10,
      status TEXT NOT NULL DEFAULT 'pending',
      created_at TIMESTAMP DEFAULT NOW()
    );
  `);
  // In case the table already existed from before this column was added
  await pool.query(`
    ALTER TABLE trade_suggestions ADD COLUMN IF NOT EXISTS stop_loss_pct INTEGER NOT NULL DEFAULT 50;
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
  "- Backtest a leveraged strategy: /backtest <symbol> [days] [target%]\n" +
  "  e.g. /backtest SOL 90 100 (10x leverage, 100% profit target)\n" +
  "- Test Bybit connection: /bybitcheck\n" +
  "- Get a trade suggestion (confirm before anything is placed): /suggest <symbol> [target%] [stoploss%]\n" +
  "  e.g. /suggest SOL 100 50 (100% take-profit, stop-loss at 50% of margin)\n" +
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
  // AI-narrative coins
  FET: 'fetch-ai', RNDR: 'render-token', TAO: 'bittensor', AGIX: 'singularitynet',
  WLD: 'worldcoin', ARKM: 'arkham', AKT: 'akash-network', GRT: 'the-graph',
  OCEAN: 'ocean-protocol',
  // Zcash (confirmed real, currently ~$1,100+)
  ZEC: 'zcash',
  // Smaller/newer ones — left for the search fallback below to resolve,
  // added here only if a confirmed exact CoinGecko ID is known
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
  const targetPct = [50, 100, 150, 200].includes(parseInt(parts[2], 10)) ? parseInt(parts[2], 10) : 100;
  const leverage = 10; // matches the stated trading plan

  if (!symbol) {
    return ctx.reply('Usage: /backtest <symbol> [days] [target%]\nTarget must be 50, 100, 150, or 200 (default 100)\nExample: /backtest SOL 90 100');
  }

  const base = symbol.endsWith('USDT') ? symbol.slice(0, -4) : symbol;

  try {
    await ctx.reply(`Backtesting ${base} over the last ${days} days — ${leverage}x leverage, ${targetPct}% take-profit target...`);

    const coinId = await resolveCoinGeckoId(base);
    if (!coinId) {
      return ctx.reply(`Couldn't find data for "${symbol}". Small/new tokens may not be listed on CoinGecko yet.`);
    }

    const url = `https://api.coingecko.com/api/v3/coins/${coinId}/market_chart?vs_currency=usd&days=${days}&interval=daily`;
    const response = await fetch(url);
    const data = await response.json();

    if (!data.prices || data.prices.length < 20) {
      return ctx.reply(`Not enough price history for "${symbol}" over ${days} days.`);
    }

    const closes = data.prices.map((p) => p[1]);
    const rsiSeries = calculateRSISeries(closes, 14);

    // Price move needed for a given leveraged return: return% = priceMove% * leverage
    const targetPriceMove = targetPct / leverage / 100; // e.g. 100% target at 10x = 10% price move
    const liquidationPriceMove = -1 / leverage; // e.g. at 10x, a -10% price move wipes the margin

    const trades = [];
    let liquidations = 0;
    let position = null;

    for (let i = 1; i < closes.length; i++) {
      const rsi = rsiSeries[i];
      const prevRsi = rsiSeries[i - 1];
      if (rsi === null || prevRsi === null) continue;

      if (!position && prevRsi > 30 && rsi <= 30) {
        position = { entryPrice: closes[i], entryIndex: i };
        continue;
      }

      if (position) {
        const priceMove = (closes[i] - position.entryPrice) / position.entryPrice;

        if (priceMove <= liquidationPriceMove) {
          trades.push(-100); // full margin lost
          liquidations++;
          position = null;
        } else if (priceMove >= targetPriceMove) {
          trades.push(targetPct); // take-profit hit
          position = null;
        }
        // otherwise: still holding, keep walking forward
      }
    }

    let openNote = '';
    if (position) {
      const unrealizedMove = (closes[closes.length - 1] - position.entryPrice) / position.entryPrice;
      const unrealizedReturn = (unrealizedMove * leverage * 100).toFixed(1);
      openNote = `\n(Still holding an open position: ${unrealizedReturn >= 0 ? '+' : ''}${unrealizedReturn}% on margin, unrealized)`;
    }

    if (trades.length === 0) {
      return ctx.reply(`No completed entries for ${base} in the last ${days} days using this RSI + take-profit strategy.${openNote}\n\n⚠️ Not financial advice.`);
    }

    const wins = trades.filter((t) => t > 0).length;
    const winRate = ((wins / trades.length) * 100).toFixed(1);
    const totalReturn = trades.reduce((sum, t) => sum + t, 0);
    const avgReturn = (totalReturn / trades.length).toFixed(1);

    ctx.reply(
      `📊 Leveraged backtest: ${base} — ${leverage}x, ${targetPct}% take-profit target, last ${days} days\n\n` +
      `Trades: ${trades.length} (${liquidations} liquidated)\n` +
      `Win rate: ${winRate}% (${wins}/${trades.length})\n` +
      `Total return on margin (summed): ${totalReturn >= 0 ? '+' : ''}${totalReturn.toFixed(1)}%\n` +
      `Average return per trade: ${avgReturn >= 0 ? '+' : ''}${avgReturn}%` +
      openNote +
      `\n\n⚠️ Simplified simulation — no fees, funding rates, or slippage included. At ${leverage}x, a ${Math.abs(liquidationPriceMove * 100).toFixed(1)}% adverse price move wipes the trade's margin. Past results don't guarantee future ones — this is not financial advice.`
    );
  } catch (err) {

    console.error('Backtest error:', err);
    ctx.reply('Something went wrong running that backtest. Try again shortly.');
  }
});

// ---- Automatic watchlist alerts (Stage 13) ----

// ---- Bybit authenticated API (Stage 15) ----

const BYBIT_BASE_URL = 'https://api.bybit.com';

// Signs and sends a GET request to Bybit's private (authenticated) API.
// This is read-only usage here — just checking account balance, no orders placed.
async function bybitSignedGet(path, params = {}) {
  const apiKey = process.env.BYBIT_API_KEY;
  const apiSecret = process.env.BYBIT_API_SECRET;
  const timestamp = Date.now().toString();
  const recvWindow = '5000';

  const queryString = Object.keys(params)
    .sort()
    .map((key) => `${key}=${params[key]}`)
    .join('&');

  const signPayload = timestamp + apiKey + recvWindow + queryString;
  const signature = crypto.createHmac('sha256', apiSecret).update(signPayload).digest('hex');

  const url = `${BYBIT_BASE_URL}${path}${queryString ? '?' + queryString : ''}`;
  const response = await fetch(url, {
    headers: {
      'X-BAPI-API-KEY': apiKey,
      'X-BAPI-TIMESTAMP': timestamp,
      'X-BAPI-RECV-WINDOW': recvWindow,
      'X-BAPI-SIGN': signature,
    },
  });

  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    // Not valid JSON — likely a block page or HTML error, same pattern as the earlier public-API issue
    throw new Error(`Bybit returned non-JSON response (first 200 chars): ${text.slice(0, 200)}`);
  }
}

// /bybitcheck - read-only connectivity + balance test, no trading
bot.command('bybitcheck', async (ctx) => {
  if (!process.env.BYBIT_API_KEY || !process.env.BYBIT_API_SECRET) {
    return ctx.reply('Bybit API keys are not set up yet on the server.');
  }

  try {
    await ctx.reply('Checking connection to Bybit...');
    const data = await bybitSignedGet('/v5/account/wallet-balance', { accountType: 'UNIFIED' });

    if (data.retCode !== 0) {
      return ctx.reply(
        `Bybit responded, but with an error:\n` +
        `Code: ${data.retCode}\n` +
        `Message: ${data.retMsg}\n\n` +
        `This usually means a permissions or key issue, not a region block (since we got a real response back).`
      );
    }

    const account = data.result?.list?.[0];
    if (!account) {
      return ctx.reply('Connected successfully, but no account data returned. Check your account has a Unified Trading balance.');
    }

    const totalEquity = parseFloat(account.totalEquity || 0).toFixed(2);
    ctx.reply(
      `✅ Bybit connection successful!\n\n` +
      `Account type: Unified Trading\n` +
      `Total equity: $${totalEquity}\n\n` +
      `This confirms Render's server CAN reach Bybit's authenticated API — the earlier region block only affected the public market-data endpoint, not this one.`
    );
  } catch (err) {
    console.error('Bybit connectivity check error:', err);
    ctx.reply(
      `❌ Connection to Bybit failed.\n\n` +
      `Error: ${err.message}\n\n` +
      `This could mean Render's region is blocked for Bybit's private API too — we'll need to look at redeploying to a different region if so.`
    );
  }
});

// Signs and sends a POST request to Bybit's private API (used for placing orders/setting leverage)
async function bybitSignedPost(path, body = {}) {
  const apiKey = process.env.BYBIT_API_KEY;
  const apiSecret = process.env.BYBIT_API_SECRET;
  const timestamp = Date.now().toString();
  const recvWindow = '5000';
  const bodyString = JSON.stringify(body);

  const signPayload = timestamp + apiKey + recvWindow + bodyString;
  const signature = crypto.createHmac('sha256', apiSecret).update(signPayload).digest('hex');

  const response = await fetch(`${BYBIT_BASE_URL}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-BAPI-API-KEY': apiKey,
      'X-BAPI-TIMESTAMP': timestamp,
      'X-BAPI-RECV-WINDOW': recvWindow,
      'X-BAPI-SIGN': signature,
    },
    body: bodyString,
  });

  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`Bybit returned non-JSON response: ${text.slice(0, 200)}`);
  }
}

// Rounds a quantity down to the symbol's allowed step size (Bybit rejects orders otherwise)
function roundToStep(value, step) {
  const precision = step.includes('.') ? step.split('.')[1].length : 0;
  const rounded = Math.floor(value / parseFloat(step)) * parseFloat(step);
  return rounded.toFixed(precision);
}

// /suggest <symbol> [target%] [stoploss%] - proposes a leveraged long trade, waits for explicit confirmation
bot.command('suggest', async (ctx) => {
  const parts = ctx.message.text.split(' ').slice(1);
  const symbol = (parts[0] || '').toUpperCase();
  const targetPct = [50, 100, 150, 200].includes(parseInt(parts[1], 10)) ? parseInt(parts[1], 10) : 100;
  // Stop-loss as a % of MARGIN you're willing to lose (not price %). Default 50% of margin.
  const stopLossPct = parseInt(parts[2], 10) > 0 && parseInt(parts[2], 10) < 100 ? parseInt(parts[2], 10) : 50;
  const leverage = 10;

  if (!symbol) {
    return ctx.reply('Usage: /suggest <symbol> [target%] [stoploss%]\nExample: /suggest SOL 100 50\n(stoploss% is % of margin you\'re willing to risk, default 50, must be under 100)');
  }

  const base = symbol.endsWith('USDT') ? symbol.slice(0, -4) : symbol;
  const bybitSymbol = `${base}USDT`;

  try {
    const coinId = await resolveCoinGeckoId(base);
    if (!coinId) return ctx.reply(`Couldn't find data for "${symbol}".`);

    const url = `https://api.coingecko.com/api/v3/coins/${coinId}/market_chart?vs_currency=usd&days=30&interval=daily`;
    const response = await fetch(url);
    const data = await response.json();
    if (!data.prices || data.prices.length < 15) {
      console.error(`CoinGecko response issue for ${symbol} (HTTP ${response.status}):`, JSON.stringify(data).slice(0, 300));
      return ctx.reply(`Not enough price history for "${symbol}" yet. (HTTP ${response.status} - check Render logs)`);
    }

    const closes = data.prices.map((p) => p[1]);
    const currentPrice = closes[closes.length - 1];
    const rsi = calculateRSI(closes, 14);

    const targetPrice = currentPrice * (1 + targetPct / leverage / 100);
    const liquidationPrice = currentPrice * (1 - 1 / leverage);
    const stopLossPrice = currentPrice * (1 - stopLossPct / leverage / 100);

    const suggestion = await pool.query(
      `INSERT INTO trade_suggestions (chat_id, symbol, target_pct, stop_loss_pct, leverage) VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [String(ctx.chat.id), bybitSymbol, targetPct, stopLossPct, leverage]
    );
    const suggestionId = suggestion.rows[0].id;

    await ctx.reply(
      `💡 Trade suggestion: ${base} LONG\n\n` +
      `${interpretRSI(rsi)}\n\n` +
      `Entry (approx): $${currentPrice.toLocaleString()}\n` +
      `Leverage: ${leverage}x\n` +
      `Margin: 10% of account equity\n` +
      `Take-profit: ${targetPct}% → approx $${targetPrice.toLocaleString()}\n` +
      `Stop-loss: -${stopLossPct}% of margin → approx $${stopLossPrice.toLocaleString()}\n` +
      `(Full liquidation would happen around $${liquidationPrice.toLocaleString()} — the stop-loss is set to close you out well before that)\n\n` +
      `⚠️ This is not financial advice. Nothing happens until you confirm below.`,
      Markup.inlineKeyboard([
        Markup.button.callback('✅ Confirm trade', `confirm_${suggestionId}`),
        Markup.button.callback('❌ Cancel', `cancel_${suggestionId}`),
      ])
    );
  } catch (err) {
    console.error('Suggest command error:', err);
    ctx.reply('Something went wrong generating that suggestion. Try again shortly.');
  }
});

bot.action(/^cancel_(\d+)$/, async (ctx) => {
  const id = ctx.match[1];
  await pool.query(`UPDATE trade_suggestions SET status = 'cancelled' WHERE id = $1`, [id]);
  await ctx.editMessageReplyMarkup(null);
  await ctx.reply('Trade cancelled — nothing was placed.');
});

bot.action(/^confirm_(\d+)$/, async (ctx) => {
  const id = ctx.match[1];

  try {
    const result = await pool.query(`SELECT * FROM trade_suggestions WHERE id = $1 AND status = 'pending'`, [id]);
    const suggestion = result.rows[0];

    if (!suggestion) {
      await ctx.answerCbQuery('This suggestion is no longer available.');
      return;
    }

    await ctx.editMessageReplyMarkup(null);
    await ctx.reply('Placing order on Bybit...');

    const { symbol, target_pct: targetPct, stop_loss_pct: stopLossPct, leverage } = suggestion;

    // 1. Get current account equity
    const balanceData = await bybitSignedGet('/v5/account/wallet-balance', { accountType: 'UNIFIED' });
    const equity = parseFloat(balanceData.result?.list?.[0]?.totalEquity || 0);
    if (!equity || equity <= 0) {
      return ctx.reply('Could not read a usable account balance. Trade not placed.');
    }
    const marginUsd = equity * 0.10;

    // 2. Get instrument info (min qty, qty step, and current price)
    const instrumentData = await bybitSignedGet('/v5/market/instruments-info', { category: 'linear', symbol });
    const instrument = instrumentData.result?.list?.[0];
    if (!instrument) {
      return ctx.reply(`Bybit doesn't list "${symbol}" as a tradeable futures pair. Trade not placed.`);
    }
    const qtyStep = instrument.lotSizeFilter.qtyStep;
    const minQty = parseFloat(instrument.lotSizeFilter.minOrderQty);

    const tickerData = await bybitSignedGet('/v5/market/tickers', { category: 'linear', symbol });
    const currentPrice = parseFloat(tickerData.result?.list?.[0]?.lastPrice);
    if (!currentPrice) {
      return ctx.reply('Could not fetch a current price for that symbol. Trade not placed.');
    }

    const positionValue = marginUsd * leverage;
    let qty = roundToStep(positionValue / currentPrice, qtyStep);
    if (parseFloat(qty) < minQty) {
      return ctx.reply(`Position size too small for ${symbol}'s minimum order size. Trade not placed. Try a smaller leverage or larger margin.`);
    }

    // 3. Set leverage for this symbol
    await bybitSignedPost('/v5/position/set-leverage', {
      category: 'linear', symbol, buyLeverage: String(leverage), sellLeverage: String(leverage),
    });

    // 4. Place the market order with BOTH take-profit and stop-loss attached
    const pricePrecision = instrument.priceFilter?.tickSize?.includes('.') ? instrument.priceFilter.tickSize.split('.')[1].length : 2;
    const takeProfitPrice = (currentPrice * (1 + targetPct / leverage / 100)).toFixed(pricePrecision);
    const stopLossPrice = (currentPrice * (1 - stopLossPct / leverage / 100)).toFixed(pricePrecision);

    const orderResult = await bybitSignedPost('/v5/order/create', {
      category: 'linear',
      symbol,
      side: 'Buy',
      orderType: 'Market',
      qty: String(qty),
      takeProfit: String(takeProfitPrice),
      stopLoss: String(stopLossPrice),
      timeInForce: 'GoodTillCancel',
    });

    if (orderResult.retCode !== 0) {
      await pool.query(`UPDATE trade_suggestions SET status = 'failed' WHERE id = $1`, [id]);
      return ctx.reply(`❌ Order failed.\nCode: ${orderResult.retCode}\nMessage: ${orderResult.retMsg}`);
    }

    await pool.query(`UPDATE trade_suggestions SET status = 'executed' WHERE id = $1`, [id]);
    ctx.reply(
      `✅ Order placed on Bybit!\n\n` +
      `${symbol} LONG — ${leverage}x\n` +
      `Qty: ${qty}\n` +
      `Margin used: ~$${marginUsd.toFixed(2)}\n` +
      `Take-profit set at: $${takeProfitPrice}\n` +
      `Stop-loss set at: $${stopLossPrice}\n\n` +
      `Monitor this on the Bybit app directly for real-time position status.`
    );
  } catch (err) {
    console.error('Trade confirmation error:', err);
    ctx.reply(`Something went wrong placing the order: ${err.message}`);
  }
});

const WATCHLIST = [
  // Original
  'SOL', 'NOM', 'MYX',
  // AI narrative
  'FET', 'RNDR', 'TAO', 'AGIX', 'WLD', 'ARKM', 'AKT', 'GRT', 'OCEAN',
  // Requested pairs
  'JCT', 'LTC', 'MUBARAK', 'XPIN', 'ZEC', 'CLCLX', 'SIREN', 'SKR', 'PENGU', 
];

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
