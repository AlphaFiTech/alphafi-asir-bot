# alphafi-betterstack — Agent Notes

AlphaFi Security and Incident Response (ASIR) Telegram bot. See `README.md` for the
escalation flow and env vars. This file captures operational recipes verified in
production so future changes are fast and safe.

## Where the authorized Telegram IDs live

Authorized users are **not** in code. `ALLOWED_USER_IDS` (comma-separated numeric
Telegram user IDs) is stored in AWS Secrets Manager and injected into the ECS task.

| | Staging | Production |
|---|---|---|
| Secret | `alphafi-betterstack-allowed-user-ids-staging` | `alphafi-betterstack-allowed-user-ids-production` |
| ECS service | `alphafi-betterstack-staging` | `alphafi-betterstack-production` |
| Bot | @AlphafiAsirStagingBot | @AlphafiAsirBot |

**Account / access (both environments):**
- AWS account: **v3** — `705393004398`
- AWS profile: `v3-mgmt-admin` (SSO session `alphafi`)
- Region: `us-east-1`
- ECS cluster: `AlphafiCluster-production` (and `AlphafiCluster-staging`)

> Note: `alphafi-mgmt-admin` (account `471112681543`) does **not** have these
> secrets — they were created in the v3 account.

## Recipe: add a new authorized Telegram ID

Get the numeric ID via [@userinfobot](https://t.me/userinfobot). Then, replacing
`<NEW_ID>` and using `-staging`/`-production` suffixes as needed:

```bash
PROFILE=v3-mgmt-admin
REGION=us-east-1
ENV=production          # or: staging
SECRET=alphafi-betterstack-allowed-user-ids-$ENV
CLUSTER=AlphafiCluster-production   # or: AlphafiCluster-staging
SERVICE=alphafi-betterstack-$ENV
NEW_ID=<NEW_ID>

# 0. Authenticate (the v3 secrets/cluster need the alphafi SSO session)
aws sso login --profile "$PROFILE"

# 1. READ the current value — never overwrite blindly; we append to preserve existing IDs
CURRENT=$(aws secretsmanager get-secret-value --profile "$PROFILE" --region "$REGION" \
  --secret-id "$SECRET" --query SecretString --output text)
echo "$CURRENT"

# 2. Guard against duplicates, then append
case ",$CURRENT," in
  *",$NEW_ID,"*) echo "Already present; nothing to do"; ;;
  *) aws secretsmanager update-secret --profile "$PROFILE" --region "$REGION" \
       --secret-id "$SECRET" --secret-string "$CURRENT,$NEW_ID" ;;
esac

# 3. Force a new ECS deployment so the running task reloads the secret
aws ecs update-service --profile "$PROFILE" --region "$REGION" \
  --cluster "$CLUSTER" --service "$SERVICE" --force-new-deployment

# 4. Wait for the rollout to complete (running 1/1, PRIMARY = COMPLETED)
until [ "$(aws ecs describe-services --profile "$PROFILE" --region "$REGION" \
  --cluster "$CLUSTER" --services "$SERVICE" \
  --query 'services[0].deployments[?status==`PRIMARY`].rolloutState' --output text)" = "COMPLETED" ]; do
  sleep 10
done
echo "Rollout complete."
```

**Why a redeploy is required:** secrets are read at container start, so an updated
secret only takes effect after the task restarts (`--force-new-deployment`).

To **remove** an ID, do the same read-then-write but build the new string without
that ID (e.g. `tr ',' '\n' | grep -vx "$ID" | paste -sd,`), then redeploy.

## Caveats learned the hard way
- The README's "Adding authorized users" snippet is outdated: it overwrites instead
  of appending and uses the cluster name `alphafi-production` (the real cluster is
  `AlphafiCluster-production`). Prefer the recipe above.
- Staging and production are **separate lists** — adding to one does not affect the other.
