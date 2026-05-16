import 'dotenv/config';
import { Telegraf, Context } from 'telegraf';
import axios from 'axios';

function escapeMarkdown(text: string): string {
  if (!text) return '';
  return text.replace(/([*_`\[])/g, '\\$1');
}

function sanitizeForApi(text: string): string {
  return text.replace(/[\x00-\x1F\x7F]/g, '').replace(/<[^>]*>/g, '').trim();
}

// Startup Guard: Validate critical environment variables
const REQUIRED_ENV = ['TELEGRAM_BOT_TOKEN', 'BETTER_STACK_API_TOKEN', 'ESCALATION_POLICY_ID'];
const missingEnv = REQUIRED_ENV.filter((key) => !process.env[key]);

if (missingEnv.length > 0) {
  console.error(`❌ CRITICAL ERROR: Missing required environment variables: ${missingEnv.join(', ')}`);
  process.exit(1);
}

const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN as string;
const BETTER_STACK_TOKEN = process.env.BETTER_STACK_API_TOKEN as string;
const POLICY_ID = process.env.ESCALATION_POLICY_ID as string;
const REQUESTER_EMAIL = process.env.REQUESTER_EMAIL ?? 'admin@alphafi.xyz';

// Validate ESCALATION_POLICY_ID is a valid integer string (Better Stack expects numeric)
if (!/^\d+$/.test(POLICY_ID)) {
  console.error(`❌ CRITICAL ERROR: ESCALATION_POLICY_ID must be a valid integer, got: "${POLICY_ID}"`);
  process.exit(1);
}

// Use numeric User IDs instead of usernames (more secure/immutable)
const ALLOWED_USERS: string[] = process.env.ALLOWED_USER_IDS
  ? process.env.ALLOWED_USER_IDS.split(',').map((id) => id.trim()).filter(Boolean)
  : [];

if (ALLOWED_USERS.length === 0) {
  console.warn('⚠️  [SECURITY WARN] ALLOWED_USER_IDS not set. All Telegram users can trigger alerts!');
}

const bot = new Telegraf(TELEGRAM_TOKEN);

// Rate Limiting (2-minute cooldown per user)
const cooldowns = new Map<string, number>();
const COOLDOWN_MS = 2 * 60 * 1000;

// Memory Cleanup: Prune expired cooldowns every 2 minutes (matches cooldown period)
const cleanupTimer = setInterval(() => {
  const now = Date.now();
  for (const [userId, lastAlert] of cooldowns.entries()) {
    if (now - lastAlert > COOLDOWN_MS) {
      cooldowns.delete(userId);
    }
  }
}, COOLDOWN_MS);

cleanupTimer.unref();

const BETTER_STACK_URL = 'https://uptime.betterstack.com/api/v3/incidents';
const HEADERS = {
  Authorization: `Bearer ${BETTER_STACK_TOKEN}`,
  'Content-Type': 'application/json',
};

/**
 * ASIR Policy Step 1:
 * User sends /alert <issue description>
 */
bot.command('alert', async (ctx: Context) => {
  const userId = ctx.from!.id.toString();
  const rawUserLabel = ctx.from!.username ? `@${ctx.from!.username}` : ctx.from!.first_name;
  const userLabel = escapeMarkdown(rawUserLabel);

  if (ALLOWED_USERS.length > 0 && !ALLOWED_USERS.includes(userId)) {
    console.warn(`[Unauthorized Access Attempt] User ID ${userId} (${rawUserLabel}) tried to trigger an alert.`);
    return ctx.reply('🚫 Error: You are not authorized to trigger AlphaFi Escalation Policies.');
  }

  const lastAlert = cooldowns.get(userId);
  const now = Date.now();
  if (lastAlert && now - lastAlert < COOLDOWN_MS) {
    const remainingSeconds = Math.ceil((COOLDOWN_MS - (now - lastAlert)) / 1000);
    return ctx.reply(`⏳ Slow down! You can trigger another alert in ${remainingSeconds}s.`);
  }

  const rawDescription = (ctx.message as { text: string }).text.split(' ').slice(1).join(' ');
  const description =
    sanitizeForApi(rawDescription) || 'Unspecified issue reported via AlphaFi SIR';
  const sanitizedUserLabel = sanitizeForApi(rawUserLabel);

  let statusMsg: Awaited<ReturnType<typeof ctx.reply>> | null = null;
  try {
    /**
     * ASIR Policy Step 2:
     * ASIR_bot triggers the Better Stack Escalation Policy
     */
    statusMsg = await ctx.reply('⏳ ASIR_bot: Initiating Better Stack Escalation Policy...');

    const payload = {
      name: `AlphaFi Alert: ${description.substring(0, 50)}`,
      summary: `Detailed Report: ${description.substring(0, 1000)} | Triggered by ${sanitizedUserLabel}`,
      requester_email: REQUESTER_EMAIL,
      policy_id: POLICY_ID,
      call: true,
    };

    const response = await axios.post(BETTER_STACK_URL, payload, {
      headers: HEADERS,
      timeout: 10000,
    });

    /**
     * ASIR Policy Step 3:
     * ASIR_bot closes the interaction in Telegram
     */
    if (response.status === 201) {
      const incidentId = (response.data as { data: { id: string } }).data.id;

      cooldowns.set(userId, Date.now());

      await ctx.telegram.editMessageText(
        ctx.chat!.id,
        statusMsg.message_id,
        undefined,
        `✅ *ASIR_bot: Policy Triggered Successfully*\n\n` +
          `🆔 *Incident ID:* \`${incidentId}\`\n` +
          `📞 *Status:* Better Stack is now calling the on-call team.\n` +
          `👤 *Origin:* ${userLabel}`,
        { parse_mode: 'Markdown' },
      );

      console.log(`[ASIR Policy Success] Incident ${incidentId} raised for AlphaFi by ${rawUserLabel}.`);
    } else {
      await ctx.telegram.editMessageText(
        ctx.chat!.id,
        statusMsg.message_id,
        undefined,
        `⚠️ *ASIR_bot: Unexpected Response*\n\nBetter Stack returned status \`${response.status}\`. The incident may not have been created correctly.`,
        { parse_mode: 'Markdown' },
      );
    }
  } catch (error) {
    const axiosError = error as { response?: { status?: number; data?: unknown }; message?: string };
    const statusCode = axiosError.response?.status ? `(Status: ${axiosError.response.status})` : '';
    console.error('ASIR Policy Failure:', axiosError.response?.data ?? axiosError.message);

    if (statusMsg) {
      await ctx.telegram.editMessageText(
        ctx.chat!.id,
        statusMsg.message_id,
        undefined,
        `❌ *ASIR_bot Error: Failed to trigger Escalation Policy* ${escapeMarkdown(statusCode)}\nCheck API logs.`,
        { parse_mode: 'Markdown' },
      );
    } else {
      await ctx.reply(`❌ ASIR_bot Error: Failed to trigger Escalation Policy. ${statusCode}\nCheck API logs.`);
    }
  }
});

bot.command('start', (ctx: Context) => {
  return ctx.reply(
    `👋 *AlphaFi ASIR Bot*\n\n` +
      `Use \`/alert <description>\` to trigger the on-call escalation policy.\n\n` +
      `Type /help for more information.`,
    { parse_mode: 'Markdown' },
  );
});

bot.command('help', (ctx: Context) => {
  return ctx.reply(
    `*AlphaFi ASIR Bot — Available Commands*\n\n` +
      `\`/alert <description>\` — Trigger the Better Stack escalation policy and phone the on-call team.\n` +
      `\`/help\` — Show this message.\n\n` +
      `*Notes:*\n` +
      `• Only authorized users can trigger alerts.\n` +
      `• A 2-minute cooldown applies between alerts per user.\n` +
      `• Failed API calls do not consume your cooldown.`,
    { parse_mode: 'Markdown' },
  );
});

bot.catch((err: unknown, ctx: Context) => {
  console.error(`[Bot Error] Update type: ${ctx.updateType}`, err);
});

bot
  .launch({ dropPendingUpdates: true })
  .then(() => console.log('✅ AlphaFi ASIR_bot is running on remote architecture...'))
  .catch((err: Error) => {
    console.error('❌ CRITICAL ERROR: Failed to launch ASIR_bot:', err.message);
    process.exit(1);
  });

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
