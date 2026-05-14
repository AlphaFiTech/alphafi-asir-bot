require('dotenv').config();
const { Telegraf } = require('telegraf');
const axios = require('axios');

/**
 * Helper: Escape characters that break Telegram Markdown (V1) rendering
 * For V1, we mainly need to escape *, _, `, and [ in user-supplied text.
 */
function escapeMarkdown(text) {
    if (!text) return '';
    return text.replace(/([*_`\[])/g, '\\$1');
}

// 1. Startup Guard: Validate critical environment variables
const REQUIRED_ENV = ['TELEGRAM_BOT_TOKEN', 'BETTER_STACK_API_TOKEN', 'ESCALATION_POLICY_ID'];
const missingEnv = REQUIRED_ENV.filter(key => !process.env[key]);

if (missingEnv.length > 0) {
    console.error(`❌ CRITICAL ERROR: Missing required environment variables: ${missingEnv.join(', ')}`);
    process.exit(1);
}

// Configuration
const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const BETTER_STACK_TOKEN = process.env.BETTER_STACK_API_TOKEN;
const POLICY_ID = parseInt(process.env.ESCALATION_POLICY_ID, 10);
const REQUESTER_EMAIL = process.env.REQUESTER_EMAIL || "admin@alphafi.xyz";

// Use numeric User IDs instead of usernames (more secure/immutable)
const ALLOWED_USERS = process.env.ALLOWED_USER_IDS ? process.env.ALLOWED_USER_IDS.split(',').map(id => id.trim()) : [];

// Startup warning if bot is open-by-default
if (ALLOWED_USERS.length === 0) {
    console.warn('⚠️  [SECURITY WARN] ALLOWED_USER_IDS not set. All Telegram users can trigger alerts!');
}

const bot = new Telegraf(TELEGRAM_TOKEN);

// Rate Limiting (2-minute cooldown per user)
const cooldowns = new Map();
const COOLDOWN_MS = 2 * 60 * 1000; 

// Memory Cleanup: Prune expired cooldowns periodically
const cleanupTimer = setInterval(() => {
    const now = Date.now();
    for (const [userId, lastAlert] of cooldowns.entries()) {
        if (now - lastAlert > COOLDOWN_MS) {
            cooldowns.delete(userId);
        }
    }
}, 60 * 60 * 1000);

// Prevent the process from hanging on shutdown due to the interval
cleanupTimer.unref();

// Better Stack API V3 Constants
const BETTER_STACK_URL = 'https://uptime.betterstack.com/api/v3/incidents';
const HEADERS = {
    'Authorization': `Bearer ${BETTER_STACK_TOKEN}`,
    'Content-Type': 'application/json'
};

/**
 * ASIR Policy Step 1: 
 * Customer responds with /alert <issue description>
 */
bot.command('alert', async (ctx) => {
    const userId = ctx.from.id.toString();
    const rawUserLabel = ctx.from.username ? `@${ctx.from.username}` : ctx.from.first_name;
    const userLabel = escapeMarkdown(rawUserLabel);

    // Security Check using Numeric ID
    if (ALLOWED_USERS.length > 0 && !ALLOWED_USERS.includes(userId)) {
        console.warn(`[Unauthorized Access Attempt] User ID ${userId} (${rawUserLabel}) tried to trigger an alert.`);
        return ctx.reply('🚫 Error: You are not authorized to trigger AlphaFi Escalation Policies.');
    }

    // Rate Limiting Check
    const lastAlert = cooldowns.get(userId);
    const now = Date.now();
    if (lastAlert && (now - lastAlert) < COOLDOWN_MS) {
        const remainingSeconds = Math.ceil((COOLDOWN_MS - (now - lastAlert)) / 1000);
        return ctx.reply(`⏳ Slow down! You can trigger another alert in ${remainingSeconds}s.`);
    }

    const description = ctx.message.text.split(' ').slice(1).join(' ') || "Unspecified issue reported via AlphaFi SIR";

    try {
        /**
         * ASIR Policy Step 2: 
         * ASIR_bot responds by triggering BEP API
         */
        const statusMsg = await ctx.reply('⏳ ASIR_bot: Initiating Better Stack Escalation Policy...');

        const payload = {
            name: `AlphaFi Alert: ${description.substring(0, 50)}`,
            summary: `Detailed Report: ${description.substring(0, 1000)} | Triggered by ${rawUserLabel}`,
            requester_email: REQUESTER_EMAIL,
            policy_id: POLICY_ID,
            call: true 
        };

        const response = await axios.post(BETTER_STACK_URL, payload, { 
            headers: HEADERS,
            timeout: 10000 // 10s timeout to prevent hanging
        });

        /**
         * ASIR Policy Step 3: 
         * ASIR_bot closes the call (Interaction closure in Telegram)
         */
        if (response.status === 201) {
            const incidentId = response.data.data.id;
            
            // Set cooldown only on successful API response
            cooldowns.set(userId, Date.now());

            await ctx.telegram.editMessageText(
                ctx.chat.id,
                statusMsg.message_id,
                null,
                `✅ *ASIR_bot: Policy Triggered Successfully*\n\n` +
                `🆔 *Incident ID:* \`${incidentId}\`\n` +
                `📞 *Status:* Better Stack is now calling the on-call team.\n` +
                `👤 *Origin:* ${userLabel}`,
                { parse_mode: 'Markdown' }
            );
            
            console.log(`[ASIR Policy Success] Incident ${incidentId} raised for AlphaFi by ${rawUserLabel}.`);
        } else {
            // Handle non-201 unexpected success codes
            await ctx.telegram.editMessageText(
                ctx.chat.id,
                statusMsg.message_id,
                null,
                `⚠️ *ASIR_bot: Unexpected Response*\n\n` +
                `Better Stack returned status \`${response.status}\`. The incident may not have been created correctly.`,
                { parse_mode: 'Markdown' }
            );
        }
    } catch (error) {
        const statusCode = error.response?.status ? `(Status: ${error.response.status})` : '';
        console.error('ASIR Policy Failure:', error.response?.data || error.message);
        await ctx.reply(`❌ ASIR_bot Error: Failed to trigger Escalation Policy. ${statusCode}\nCheck API logs.`);
    }
});

bot.catch((err, ctx) => {
    console.error(`[Bot Error] Update type: ${ctx.updateType}`, err);
});

// Start the bot with protection against old/pending updates
bot.launch({
    dropPendingUpdates: true
}).then(() => {
    console.log('✅ AlphaFi ASIR_bot is running on remote architecture...');
}).catch((err) => {
    console.error('❌ CRITICAL ERROR: Failed to launch ASIR_bot:', err.message);
    process.exit(1);
});

// Graceful termination
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
