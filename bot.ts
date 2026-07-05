import 'dotenv/config';
import { Telegraf, Context } from 'telegraf';
import axios from 'axios';
import pino from 'pino';

const log = pino({ level: process.env.LOG_LEVEL ?? 'info' });

function escapeMarkdown(text: string): string {
  if (!text) return '';
  return text.replace(/([*_`\[])/g, '\\$1');
}

function sanitizeForApi(text: string): string {
  return text
    .replace(/[\x00-\x1F\x7F]/g, '')
    .replace(/<[^>]*>/g, '')
    .trim();
}

// Startup Guard: Validate critical environment variables
const REQUIRED_ENV = ['TELEGRAM_BOT_TOKEN', 'BETTER_STACK_API_TOKEN', 'ESCALATION_POLICY_ID'];
const missingEnv = REQUIRED_ENV.filter((key) => !process.env[key]);

if (missingEnv.length > 0) {
  log.fatal({ missingEnv }, 'Missing required environment variables');
  process.exit(1);
}

const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN as string;
const BETTER_STACK_TOKEN = process.env.BETTER_STACK_API_TOKEN as string;
const POLICY_ID = process.env.ESCALATION_POLICY_ID as string;
const REQUESTER_EMAIL = process.env.REQUESTER_EMAIL ?? 'admin@alphafi.xyz';

// Validate ESCALATION_POLICY_ID is a valid integer string (Better Stack expects numeric)
if (!/^\d+$/.test(POLICY_ID)) {
  log.fatal({ POLICY_ID }, 'ESCALATION_POLICY_ID must be a valid integer');
  process.exit(1);
}

// Use numeric User IDs instead of usernames (more secure/immutable)
const ALLOWED_USERS: string[] = process.env.ALLOWED_USER_IDS
  ? process.env.ALLOWED_USER_IDS.split(',')
      .map((id) => id.trim())
      .filter(Boolean)
  : [];

if (ALLOWED_USERS.length === 0) {
  log.warn('ALLOWED_USER_IDS not set — all Telegram users can trigger alerts');
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
    log.warn({ userId, userLabel: rawUserLabel }, 'Unauthorized access attempt');
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

      log.info(
        { incidentId, userId, userLabel: rawUserLabel },
        'ASIR policy triggered successfully',
      );
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
    const axiosError = error as {
      response?: { status?: number; data?: unknown };
      message?: string;
    };
    const statusCode = axiosError.response?.status ? `(Status: ${axiosError.response.status})` : '';
    log.error(
      {
        userId,
        status: axiosError.response?.status,
        detail: axiosError.response?.data ?? axiosError.message,
      },
      'ASIR policy trigger failed',
    );

    if (statusMsg) {
      await ctx.telegram.editMessageText(
        ctx.chat!.id,
        statusMsg.message_id,
        undefined,
        `❌ *ASIR_bot Error: Failed to trigger Escalation Policy* ${escapeMarkdown(statusCode)}\nCheck API logs.`,
        { parse_mode: 'Markdown' },
      );
    } else {
      await ctx.reply(
        `❌ ASIR_bot Error: Failed to trigger Escalation Policy. ${statusCode}\nCheck API logs.`,
      );
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
      `\`/status\` — Check if the bot is running and connected to Better Stack.\n` +
      `\`/help\` — Show this message.\n\n` +
      `*Notes:*\n` +
      `• Only authorized users can trigger alerts.\n` +
      `• A 2-minute cooldown applies between alerts per user.\n` +
      `• Failed API calls do not consume your cooldown.`,
    { parse_mode: 'Markdown' },
  );
});

bot.command('status', async (ctx: Context) => {
  const userId = ctx.from!.id.toString();
  const rawUserLabel = ctx.from!.username ? `@${ctx.from!.username}` : ctx.from!.first_name;

  if (ALLOWED_USERS.length > 0 && !ALLOWED_USERS.includes(userId)) {
    log.warn({ userId, userLabel: rawUserLabel }, 'Unauthorized /status access attempt');
    return ctx.reply('🚫 Error: You are not authorized to use this command.');
  }

  const lastCheck = cooldowns.get(`status:${userId}`);
  const now = Date.now();
  if (lastCheck && now - lastCheck < COOLDOWN_MS) {
    const remainingSeconds = Math.ceil((COOLDOWN_MS - (now - lastCheck)) / 1000);
    return ctx.reply(`⏳ Slow down! You can check status again in ${remainingSeconds}s.`);
  }
  cooldowns.set(`status:${userId}`, now);

  const statusMsg = await ctx.reply('⏳ Checking Better Stack connectivity...');

  try {
    const response = await axios.get(`${BETTER_STACK_URL}?per_page=1`, {
      headers: HEADERS,
      timeout: 10000,
    });

    const authLine = ALLOWED_USERS.length === 0
      ? '⚠️ *Auth:* No allowlist set — all users can trigger alerts'
      : `🔒 *Auth:* Allowlist active (${ALLOWED_USERS.length} user${ALLOWED_USERS.length === 1 ? '' : 's'})`;

    const policyLine = `📋 *Policy ID:* \`${POLICY_ID}\``;

    log.info({ userId, httpStatus: response.status }, '/status check passed');

    await ctx.telegram.editMessageText(
      ctx.chat!.id,
      statusMsg.message_id,
      undefined,
      `✅ *ASIR Bot Status*\n\n` +
        `🤖 *Bot:* Running\n` +
        `🌐 *Better Stack API:* Connected (HTTP ${response.status})\n` +
        `${policyLine}\n` +
        `${authLine}`,
      { parse_mode: 'Markdown' },
    );
  } catch (error) {
    const axiosError = error as { response?: { status?: number }; message?: string };
    const detail = axiosError.response?.status
      ? `HTTP ${axiosError.response.status}`
      : axiosError.message;

    log.error({ userId, detail }, '/status check failed');

    await ctx.telegram.editMessageText(
      ctx.chat!.id,
      statusMsg.message_id,
      undefined,
      `❌ *ASIR Bot Status*\n\n` +
        `🤖 *Bot:* Running\n` +
        `🌐 *Better Stack API:* Unreachable (${escapeMarkdown(detail ?? '')})\n\n` +
        `_The bot cannot trigger alerts until connectivity is restored._`,
      { parse_mode: 'Markdown' },
    );
  }
});

bot.catch((err: unknown, ctx: Context) => {
  log.error({ updateType: ctx.updateType, err }, 'Unhandled bot error');
});

bot
  .launch({ dropPendingUpdates: true })
  .then(() => log.info('AlphaFi ASIR_bot is running'))
  .catch((err: Error) => {
    log.fatal({ err: err.message }, 'Failed to launch ASIR_bot');
    process.exit(1);
  });

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
