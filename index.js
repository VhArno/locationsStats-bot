const cron = require("node-cron");
const dotenv = require('dotenv');
const qrcode = require("qrcode-terminal");
const csv = require('csv-parser');
const { simpleParser } = require('mailparser');
const { Client, LocalAuth } = require("whatsapp-web.js");
const Imap = require('imap');
const { Readable } = require('stream');

dotenv.config();

// ─────────────────────────────────────────────
// CONFIGURATION — edit these values
// ─────────────────────────────────────────────

const DEDICATED_EMAIL = process.env.DEDICATED_EMAIL_SENDER;
const GROUP_NAME = "Test: WA Rankings";
const TIMEZONE = process.env.TIMEZONE || 'UTC';

// Locations to exclude from the leaderboard
const EXCLUDING = [];


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
    // Check immediately on startup for the most recent email
    checkEmails();
});

// ─────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────

const totals = {};

const SUFFIXES = ['NPL', 'Vriendenloterij', 'VriendenLoterij', 'DPG'];
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
        .filter(([name]) => !EXCLUDING.includes(name))
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

function checkEmails() {
    return new Promise((resolve) => {
        console.log('⏰ Checking for new emails...');

        const imap = new Imap({
            user: process.env.GMAIL_ADDRESS,
            password: process.env.GMAIL_APP_PASSWORD,
            host: process.env.GMAIL_HOST,
            port: 993,
            tls: true,
            tlsOptions: { rejectUnauthorized: false },
        });

        imap.once('error', (err) => {
            console.error('IMAP connection error:', err);
            resolve();
        });

        imap.once('ready', () => {
            imap.openBox('INBOX', false, (err) => {
                if (err) {
                    console.error('Error opening inbox:', err);
                    imap.end();
                    return resolve();
                }

                imap.search(['UNSEEN', ['FROM', DEDICATED_EMAIL]], (err, uids) => {
                    if (err) {
                        console.error('Search error:', err);
                        imap.end();
                        return resolve();
                    }

                    if (!uids || uids.length === 0) {
                        console.log('No matching unseen emails from dedicated sender.');
                        imap.end();
                        return resolve();
                    }

                    const lastUid = uids[uids.length - 1];
                    console.log(`📬 Processing most recent email (${uids.length} unread total).`);

                    Object.keys(totals).forEach((k) => delete totals[k]);

                    let gotNewData = false;
                    const f = imap.fetch([lastUid], { bodies: '' });
                    const messagePromises = [];

                    f.on('message', (msg) => {
                        const chunks = [];
                        let uid;

                        msg.on('body', (stream) => {
                            stream.on('data', (chunk) => chunks.push(chunk));
                        });

                        msg.once('attributes', (attrs) => {
                            uid = attrs.uid;
                        });

                        const msgPromise = new Promise((msgResolve) => {
                            msg.once('end', async () => {
                                try {
                                    const raw = Buffer.concat(chunks);
                                    const parsed = await simpleParser(raw);
                                    console.log(`📧 Processing: '${parsed.subject}'`);

                                    if (!parsed.attachments || parsed.attachments.length === 0) {
                                        console.log('No attachments found.');
                                    } else {
                                        for (const attachment of parsed.attachments) {
                                            if (attachment.contentType?.startsWith('image/')) continue;
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

                                    if (uid) {
                                        imap.addFlags(uid, ['\\Seen'], () => console.log('📬 Marked as read.'));
                                    }
                                } catch (ex) {
                                    console.error('Error processing message:', ex);
                                }
                                msgResolve();
                            });
                        });

                        messagePromises.push(msgPromise);
                    });

                    f.once('error', (err) => console.error('Fetch error:', err));

                    f.once('end', async () => {
                        await Promise.all(messagePromises);
                        if (gotNewData) await sendSummary();
                        imap.end();
                        resolve();
                    });
                });
            });
        });

        imap.connect();
    });
}

// ─────────────────────────────────────────────
// SCHEDULING
// emails arrive at :00 and :30 → check at :05 and :35
// ─────────────────────────────────────────────

cron.schedule('2,32 * * * *', checkEmails, { timezone: TIMEZONE });

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