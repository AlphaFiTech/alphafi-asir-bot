# alphafi-betterstack

AlphaFi Security and Incident Response (ASIR) Bot — bridges Telegram `/alert` commands to the Better Stack escalation policy, triggering immediate phone calls to the on-call team.

## Escalation flow

1. Authorized user sends `/alert <description>` in the designated Telegram group
2. Bot calls the Better Stack Incident API (`call: true`)
3. Bot replies with the confirmed Better Stack Incident ID
4. Better Stack phones the on-call team per the escalation policy

## Environment variables

| Variable                 | Required | Description                                                                 |
| ------------------------ | -------- | --------------------------------------------------------------------------- |
| `TELEGRAM_BOT_TOKEN`     | Yes      | Telegram bot token from @BotFather                                          |
| `BETTER_STACK_API_TOKEN` | Yes      | Better Stack API token                                                      |
| `ESCALATION_POLICY_ID`   | Yes      | Better Stack escalation policy ID (numeric string)                          |
| `ALLOWED_USER_IDS`       | Yes      | Comma-separated numeric Telegram user IDs authorized to trigger alerts      |
| `REQUESTER_EMAIL`        | No       | Email shown in Better Stack incidents (default: `admin@alphafi.xyz`)        |
| `LOG_LEVEL`              | No       | Pino log level: `fatal`, `error`, `warn`, `info`, `debug` (default: `info`) |

## Running locally

```bash
cp .env.example .env   # fill in your values
npm install
npm run dev            # tsx bot.ts — runs TypeScript directly
```

## Running via Docker

```bash
docker build -t alphafi-betterstack .
docker run --env-file .env alphafi-betterstack
```

## Developer workflow

```bash
make fmt          # format with Prettier
make lint         # ESLint
make typecheck    # tsc --noEmit
make build        # docker build
make ci           # typecheck + lint + fmt check
```

Install pre-commit hooks (requires [pre-commit](https://pre-commit.com)):

```bash
pre-commit install
```

## Adding authorized users

`ALLOWED_USER_IDS` is a comma-separated list stored in AWS Secrets Manager (account
`705393004398`, profile `v3-mgmt-admin`, region `us-east-1`). Get the user's numeric
Telegram ID (e.g., via [@userinfobot](https://t.me/userinfobot)), then **read the
current value and append** to it — do not overwrite, or you will drop existing users.
Finally, force a new ECS deployment so the task reloads the secret.

```bash
aws sso login --profile v3-mgmt-admin   # SSO session: alphafi

# 1. Read the current list and append the new ID
CURRENT=$(aws secretsmanager get-secret-value --profile v3-mgmt-admin --region us-east-1 \
  --secret-id alphafi-betterstack-allowed-user-ids-production --query SecretString --output text)
aws secretsmanager update-secret --profile v3-mgmt-admin --region us-east-1 \
  --secret-id alphafi-betterstack-allowed-user-ids-production \
  --secret-string "$CURRENT,<NEW_ID>"

# 2. Redeploy so the running task picks up the updated secret
aws ecs update-service --profile v3-mgmt-admin --region us-east-1 \
  --cluster AlphafiCluster-production \
  --service alphafi-betterstack-production \
  --force-new-deployment
```

For staging, use the `-staging` secret/service suffixes and cluster `AlphafiCluster-staging`.
Staging and production are separate lists. See `CLAUDE.md` for the full recipe (duplicate
guard, removal, rollout wait).

## Rate limiting

Each authorized user has a 2-minute cooldown between alerts. Cooldown is only applied on a successful Better Stack API response — failed calls do not lock out the user.

> **Note:** Cooldown state is in-memory and resets on bot restart (deploy, crash). For a 2-minute window this is acceptable; a compromised window lasts at most 2 minutes.

## AWS deployment

Infrastructure is provisioned via CDK in [alphafi-aws](https://github.com/AlphaFiTech/alphafi-aws) (`feature/asir-bot-ecs`). See that repo for ECS Fargate service definition, Secrets Manager setup, and CloudWatch monitoring.
