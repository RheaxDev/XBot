require('dotenv').config();
const puppeteer = require('puppeteer');
const { default: fetch } = require('node-fetch');
const sqlite3 = require('sqlite3').verbose();
const dayjs = require('dayjs');
const http = require('http');
const utc = require('dayjs/plugin/utc');
const timezone = require('dayjs/plugin/timezone');

dayjs.extend(utc);
dayjs.extend(timezone);

// Validate required environment variables
const requiredEnvVars = ['IVASMS_EMAIL', 'IVASMS_PASSWORD', 'TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHAT_ID'];
for (const envVar of requiredEnvVars) {
  if (!process.env[envVar]) {
    console.error(`Error: ${envVar} environment variable is required but not set`);
    process.exit(1);
  }
}
const sqlite3 = require('sqlite3').verbose();
const dayjs = require('dayjs');
const http = require('http');
const utc = require('dayjs/plugin/utc');
const timezone = require('dayjs/plugin/timezone');
dayjs.extend(utc);
dayjs.extend(timezone);

const EMAIL = process.env.IVASMS_EMAIL;
const PASSWORD = process.env.IVASMS_PASSWORD;
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const LOGIN_URL = 'https://www.ivasms.com/login';
const SMS_URL = 'https://www.ivasms.com/portal/live/my_sms';

const db = new sqlite3.Database('./db.sqlite');
db.run(`CREATE TABLE IF NOT EXISTS otps (otp TEXT, number TEXT, UNIQUE(otp, number))`);

async function sendTelegram({ number, service, otp, message, time }) {
  const text = [
    '🟢🟢🟢 OTP Received 🟢🟢🟢',
    '',
    `⏰ Time: \`${time}\``,
    `☎️ Number: \`${number}\``,
    `⚙️ Service: \`${service}\``,
    `🐦‍🔥 OTP Code: ***${otp}***`,
    `📱 Message: \`${message}\``,
    '',
    '⚙ —⟩⟩ 𝙋𝙤𝙬𝙚𝙧𝙚𝙙 𝘽𝙮 ⚡️ 𝘿𝙚𝙫 ⚡️🌏'
  ].join('\n');

  const reply_markup = {
    inline_keyboard: [
      [
        { text: '📞 Copy Number', url: `tg://msg?text=${number}` },
        { text: '🔑 Copy OTP', url: `tg://msg?text=${otp}` }
      ]
    ]
  };

  try {
    const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: CHAT_ID,
        text,
        parse_mode: 'Markdown',
        reply_markup
      })
    });
    const data = await res.json();
    if (!data.ok) {
      console.error('Telegram API error:', data);
    } else {
      console.log('Telegram message sent:', data.result.message_id);
      console.log(`✅ Successfully sent OTP: ${otp} for number: ${number} (Service: ${service})`);
    }
  } catch (err) {
    console.error('Telegram fetch error:', err);
  }
}

async function login(page) {
  await page.goto(LOGIN_URL, { waitUntil: 'networkidle2' });
  await page.type('input[name="email"]', EMAIL, { delay: 50 });
  await page.type('input[name="password"]', PASSWORD, { delay: 50 });
  await page.click('input[name="remember"]');
  await Promise.all([
    page.click('button[type="submit"]'),
    page.waitForNavigation({ waitUntil: 'networkidle2' })
  ]);
  console.log('Login successful!');
}


// Create HTTP server for keep-alive
const server = http.createServer((req, res) => {
  res.writeHead(200);
  res.end('Bot is alive!');
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});

async function monitor() {
  console.log('Bot started');
  try {
    const browser = await puppeteer.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox']
    });
    const page = await browser.newPage();

    async function ensureLoggedIn() {
      if (page.url() !== SMS_URL) {
        await login(page);
        await page.goto(SMS_URL, { waitUntil: 'networkidle2' });
      }
    }

    await ensureLoggedIn();
    console.log('Ready to monitor live SMS page.');
    // Send confirmation message to Telegram
    const confirmMsg = {
      number: '✅',
      service: '✅',
      otp: '✅',
      message: '🤖 Bot is now online and actively monitoring IVASMS live SMS page.',
      time: dayjs().tz('Asia/Kolkata').format('DD/MM/YYYY, HH:mm:ss')
    };
    await sendTelegram(confirmMsg);

    await page.exposeFunction('processRow', async (row) => {
      console.log('processRow called with:', row);
      const { service, number, otp, message } = row;
      if (!otp || !number) {
        console.log('No OTP or number found in row:', row);
        return;
      }

      db.get('SELECT 1 FROM otps WHERE otp=? AND number=?', [otp, number], async (err, row) => {
        if (err) {
          console.error('DB error:', err);
          return;
        }
        if (!row) {
          db.run('INSERT INTO otps (otp, number) VALUES (?, ?)', [otp, number]);
          const time = dayjs().tz('Asia/Kolkata').format('DD/MM/YYYY, HH:mm:ss');
          console.log('Sending to Telegram:', { number, service, otp, message, time });
          await sendTelegram({ number, service, otp, message, time });
          console.log(`Extracted OTP: ${otp}`);
        } else {
          console.log('Duplicate OTP+number, not sending:', otp, number);
        }
      });
    });

    await page.exposeFunction('onSessionExpired', async () => {
      await ensureLoggedIn();
    });

    await page.evaluate(() => {
      function extractRow(tr) {
        // Adjust selectors as per actual table structure
        const tds = tr.querySelectorAll('td');
        if (tds.length < 5) return null;
        const service = tds[0].innerText.trim();
        const number = tds[1].innerText.trim();
        const message = tds[4].innerText.trim();
        const otpMatch = message.match(/\b\d{4,6}\b/);
        const otp = otpMatch ? otpMatch[0] : null;
        return { service, number, otp, message };
      }

      let lastRowKey = null;

      function checkSession() {
        if (document.location.pathname === '/login') {
          window.onSessionExpired();
        }
      }

      const table = document.querySelector('table'); // Adjust selector if needed
      if (!table) {
        console.log('No table found on page');
        return;
      }

      const observer = new MutationObserver(() => {
        checkSession();
        const tr = table.querySelector('tbody tr');
        if (!tr) {
          console.log('No tr found in tbody');
          return;
        }
        const row = extractRow(tr);
        console.log('Extracted row:', row);
        if (!row) {
          console.log('Row extraction failed');
          return;
        }
        const key = row.otp + '_' + row.number;
        if (key !== lastRowKey) {
          lastRowKey = key;
          window.processRow(row);
        }
      });

      observer.observe(table.querySelector('tbody'), { childList: true, subtree: false });

      // Initial trigger
      const tr = table.querySelector('tbody tr');
      if (tr) {
        const row = extractRow(tr);
        console.log('Initial extracted row:', row);
        if (row) {
          lastRowKey = row.otp + '_' + row.number;
          window.processRow(row);
        }
      } else {
        console.log('No tr found in tbody on initial load');
      }
    });

    // Keep alive
    setInterval(async () => {
      if (page.url().includes('/login')) {
        await login(page);
        await page.goto(SMS_URL, { waitUntil: 'networkidle2' });
      }
    }, 60000);
  } catch (err) {
    console.error('Fatal error:', err);
  }
}

// Create HTTP server for keep-alive
// Create HTTP server for keep-alive
const server = http.createServer((req, res) => {
  res.writeHead(200);
  res.end('Bot is alive!');
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});

monitor();
