const cron = require("node-cron");
const dotenv = require('dotenv');
const qrcode = require("qrcode-terminal");
const csv = require('csv-parser');
const { simpleParser } = require('mailparser');
const { Client, LocalAuth } = require("whatsapp-web.js");
const { ImapFlow } = require('imapflow');
const { Readable } = require('stream');

dotenv.config();

// ─────────────────────────────────────────────
// CONFIGURATION — edit these values
// ─────────────────────────────────────────────

const DEDICATED_EMAIL = process.env.DEDICATED_EMAIL_SENDER;
const GROUP_NAME = "Test: WA Rankings";
const TIMEZONE = process.env.TIMEZONE || 'UTC';
const totals = {};

const excluding = ['Amsterdam_4'];

// ─────────────────────────────────────────────
// WHATSAPP CLIENT
// ─────────────────────────────────────────────

const client = new Client({
    authStrategy: new LocalAuth({
        clientId: "locations", 
        dataPath: "./sessions-locations"
    }),
    puppeteer: { 
        executablePath: '/usr/bin/chromium-browser', 
        args: ['--no-sandbox', '--disable-setuid-sandbox']
    },
});

client.on("qr", (qr) => {
  console.log("📱 Scan this QR code with your spare WhatsApp number:\n");
  qrcode.generate(qr, { small: true });
});

client.on("ready", () => {
  console.log("✅ Bot is ready!");
  getEmails();
});

// ─────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────

const SUFFIXES = ['NPL', 'Vriendenloterij', 'DPG', 'VriendenLoterij'];
const normalizeKey = (value) => {
  if (typeof value !== 'string') return '';
  let key = value.trim();
  for (const suffix of SUFFIXES) {
    if (key.endsWith(' ' + suffix)) {
      key = key.slice(0, -(suffix.length + 1)).trim();
      break;
    }
  }
  return key;
};

const addToTotals = (name, amount) => {
    if (!name || typeof amount !== 'number' || Number.isNaN(amount)) return;
    const key = normalizeKey(name);
    totals[key] = (totals[key] || 0) + amount;
};

const sendSummary = async () => {
    const entries = Object.entries(totals)
        .filter(([name, total]) => !excluding.includes(name))
        .map(([name, total]) => ({ name, total }))
        .sort((a, b) => b.total - a.total);

    if (!entries.length) {
        console.log('No totals to summarize yet.');
        return;
    }

    const lines = entries.map((row, idx) => `${idx + 1}. ${row.name}: ${row.total}`);
    const total = entries.reduce((sum, row) => sum + row.total, 0);

    const message = `🏆 *Leaderboard*\n${lines.join('\n')}\n🔥 *Total:* ${total}`;

    const chats = await client.getChats();
    const group = chats.find((c) => c.isGroup && c.name === GROUP_NAME);
    if (!group) {
        console.log(`❌ WhatsApp group '${GROUP_NAME}' not found.`);
        return;
    }

    await client.sendMessage(group.id._serialized || group.id, message);
    console.log('✅ Sent summary to WhatsApp group.');
};

const parseCsvBuffer = (buffer) => new Promise((resolve, reject) => {
    const rows = [];
    Readable.from(buffer)
        .pipe(csv())
        .on('data', (row) => rows.push(row))
        .on('end', () => resolve(rows))
        .on('error', reject);
});

async function processNewEmails(imap) {
    const uids = await imap.search({ seen: false, from: DEDICATED_EMAIL });

    if (!uids || uids.length === 0) {
        console.log('No matching unseen emails from dedicated sender.');
        return;
    }

    // Only take the last (most recent) email
    const lastUid = [uids[uids.length - 1]];
    console.log(`📬 Processing most recent email (${uids.length} unread total).`);

    // Clear totals so we show only the data from this email
    Object.keys(totals).forEach((k) => delete totals[k]);

    let gotNewData = false;

    for await (const message of imap.fetch(lastUid, { source: true })) {
        const parsed = await simpleParser(message.source);
        console.log(`📧 Processing: '${parsed.subject}'`);

        if (!parsed.attachments || parsed.attachments.length === 0) {
            console.log('No attachments found.');
        } else {
            for (const attachment of parsed.attachments) {
                if (attachment.contentType && attachment.contentType.startsWith('image/')) continue;

                try {
                    const rows = await parseCsvBuffer(attachment.content);
                    rows.forEach((row) => {
                        const name = row.Location_employee;
                        const total = Number(row.Total);
                        if (name && !Number.isNaN(total)) {
                            addToTotals(name, total);
                            gotNewData = true;
                        }
                    });
                    console.log(`✅ Parsed ${rows.length} rows from ${attachment.filename}`);
                } catch (ex) {
                    console.error('Failed to parse CSV:', attachment.filename, ex);
                }
            }
        }

        imap.messageFlagsAdd(message.uid, ['\\Seen'], { uid: true }).catch(() => {});
        console.log('📬 Marked as read.');
    }

    if (gotNewData) await sendSummary();
}

// ─────────────────────────────────────────────
// REAL-TIME EMAIL LISTENER (IMAPFLOW IDLE)
// ─────────────────────────────────────────────

async function getEmails() {
    while (true) {
        const imap = new ImapFlow({
            host: process.env.GMAIL_HOST,
            port: 993,
            secure: true,
            auth: {
                user: process.env.GMAIL_ADDRESS,
                pass: process.env.GMAIL_APP_PASSWORD,
            },
            tls: { rejectUnauthorized: false },
            logger: false,
        });

        try {
            await imap.connect();
            console.log('📭 Connected to mailbox, waiting for new emails...');

            const lock = await imap.getMailboxLock('INBOX');

            try {
                // Process most recent unread email on startup
                await processNewEmails(imap);

                while (true) {
                    await new Promise((resolve, reject) => {
                        imap.once('exists', resolve);
                        imap.once('error', reject);
                        imap.idle().catch(reject);
                    });

                    console.log('📩 New message detected, checking inbox...');
                    try {
                        await processNewEmails(imap);
                    } catch (ex) {
                        console.error('Error processing email:', ex.message);
                    }
                }

            } finally {
                lock.release();
            }

        } catch (ex) {
            console.error(`IMAP error (${ex.code || ex.message}), reconnecting in 5s...`);
        } finally {
            try { await imap.logout(); } catch (_) {}
        }

        await new Promise(res => setTimeout(res, 5000));
    }
}

// ─────────────────────────────────────────────
// MIDNIGHT RESET
// ─────────────────────────────────────────────

cron.schedule("0 0 * * *", () => {
    Object.keys(totals).forEach((k) => delete totals[k]);
    console.log("🔄 Midnight reset — all totals cleared.");
}, { timezone: TIMEZONE });

// ─────────────────────────────────────────────
// TERMINAL COMMANDS: send | reset | status
// ─────────────────────────────────────────────

process.stdin.resume();
process.stdin.setEncoding("utf8");
process.stdin.on("data", (input) => {
    const cmd = input.trim().toLowerCase();
    if (cmd === "send") { console.log("🖐 Manual summary triggered..."); sendSummary(); }
    if (cmd === "reset") { Object.keys(totals).forEach((k) => delete totals[k]); console.log("🔄 Totals reset."); }
    if (cmd === "status") { console.log("📋 Current totals:", totals); }
});

client.initialize();