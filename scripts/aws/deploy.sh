#!/usr/bin/env bash
#
# Deploy the cash relayer (relay-cash.js) to AWS Lambda, the way HyperVeil's
# keeper is deployed, inside the always-free tier.
#
#   cd bridge/scripts && bash aws/deploy.sh
#
# What it creates (idempotent: re-running updates instead of failing):
#   DynamoDB     veil-cash-relayer            2/2 provisioned (free tier: 25/25)
#   IAM          veil-cash-relayer-role       logs + that one table
#   Lambda       veil-cash-relayer-tick       one pass, one at a time
#   EventBridge  veil-cash-relayer-schedule   rate(1 minute)
#
# Cost: Lambda's 1M requests + 400k GB-s per month and DynamoDB's 25 GB + 25
# capacity units are always free. One pass a minute (~43k invocations) stays
# inside them. The relayer's key is a Lambda environment variable, encrypted at
# rest with the AWS-managed key, as the keeper's are (Secrets Manager bills per
# secret).
#
# Reads the same .env the local relayer uses. The deployment is bundled with
# the function, so re-run this after deploy-cash.js moves the cash leg. On the
# first run the local relayer's progress (.relay-cash/) seeds the table; stop
# any local relay-cash.js once this is deployed, or both send from one account.

set -euo pipefail

HERE="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" &> /dev/null && pwd)"
SCRIPTS_DIR="$(cd -- "$HERE/.." &> /dev/null && pwd)"
ENV_FILE="${RELAY_ENV_FILE:-$SCRIPTS_DIR/.env}"
EVM_NET="${RELAY_EVM:-ethereum-sepolia}"
SN_NET="${RELAY_STARKNET:-starknet-sepolia}"
DEPLOYMENT="$SCRIPTS_DIR/../deployments/${EVM_NET}__${SN_NET}.json"
LOCAL_STATE="$SCRIPTS_DIR/.relay-cash/${EVM_NET}__${SN_NET}.json"

REGION="${AWS_REGION:-$(aws configure get region || echo us-east-1)}"
TABLE="${RELAY_STATE_TABLE:-veil-cash-relayer}"
ROLE_NAME="${RELAY_ROLE_NAME:-veil-cash-relayer-role}"
FN="${RELAY_FUNCTION:-veil-cash-relayer-tick}"
RULE_NAME="${RELAY_RULE_NAME:-veil-cash-relayer-schedule}"
SCHEDULE="${RELAY_SCHEDULE:-rate(1 minute)}"
TIMEOUT="${RELAY_TIMEOUT:-300}"
MEMORY="${RELAY_MEMORY:-512}"

for cmd in aws jq node zip python3; do
    command -v "$cmd" >/dev/null || { echo "error: '$cmd' is required" >&2; exit 1; }
done
[[ -f "$ENV_FILE" ]] || { echo "error: no $ENV_FILE" >&2; exit 1; }
[[ -f "$DEPLOYMENT" ]] || { echo "error: no $DEPLOYMENT" >&2; exit 1; }
jq -e '.cash.vault and .cash.source.tokenMessenger' "$DEPLOYMENT" >/dev/null \
    || { echo "error: no cash leg in $DEPLOYMENT: run deploy-cash.js" >&2; exit 1; }

ACCOUNT="$(aws sts get-caller-identity --query Account --output text)"
echo "account   $ACCOUNT"
echo "region    $REGION"
echo "vault     $(jq -r .cash.vault "$DEPLOYMENT") ($EVM_NET -> $SN_NET)"

# ── 1. State table ───────────────────────────────────────────────────────────
echo
echo "[1/5] DynamoDB $TABLE"
if aws dynamodb describe-table --table-name "$TABLE" --region "$REGION" >/dev/null 2>&1; then
    echo "      exists"
else
    aws dynamodb create-table --region "$REGION" \
        --table-name "$TABLE" \
        --attribute-definitions AttributeName=pk,AttributeType=S \
        --key-schema AttributeName=pk,KeyType=HASH \
        --provisioned-throughput ReadCapacityUnits=2,WriteCapacityUnits=2 \
        --query 'TableDescription.TableStatus' --output text
    aws dynamodb wait table-exists --table-name "$TABLE" --region "$REGION"
    echo "      created"
fi
if [[ "$(aws dynamodb get-item --table-name "$TABLE" --region "$REGION" \
        --key '{"pk":{"S":"state"}}' --query 'Item.pk.S' --output text)" == "None" ]]; then
    if [[ -f "$LOCAL_STATE" ]]; then
        aws dynamodb put-item --table-name "$TABLE" --region "$REGION" \
            --item "$(jq -nc --arg j "$(jq -c . "$LOCAL_STATE")" --arg at "$(date +%s000)" \
                '{pk:{S:"state"},json:{S:$j},at:{N:$at}}')"
        echo "      seeded from $LOCAL_STATE"
    else
        echo "      empty: the first pass reads the last 5,000 Ethereum blocks"
    fi
fi

# ── 2. Role ──────────────────────────────────────────────────────────────────
echo
echo "[2/5] IAM $ROLE_NAME"
TRUST='{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"Service":"lambda.amazonaws.com"},"Action":"sts:AssumeRole"}]}'
if aws iam get-role --role-name "$ROLE_NAME" >/dev/null 2>&1; then
    echo "      exists"
else
    aws iam create-role --role-name "$ROLE_NAME" \
        --assume-role-policy-document "$TRUST" --query 'Role.Arn' --output text
    aws iam attach-role-policy --role-name "$ROLE_NAME" \
        --policy-arn arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole
    echo "      created; waiting for it to propagate"
    sleep 12
fi
aws iam put-role-policy --role-name "$ROLE_NAME" --policy-name state-table \
    --policy-document "$(jq -nc --arg t "arn:aws:dynamodb:$REGION:$ACCOUNT:table/$TABLE" \
        '{Version:"2012-10-17",Statement:[{Effect:"Allow",Action:["dynamodb:GetItem","dynamodb:PutItem","dynamodb:DeleteItem"],Resource:$t}]}')"
ROLE_ARN="$(aws iam get-role --role-name "$ROLE_NAME" --query 'Role.Arn' --output text)"
echo "      $ROLE_ARN"

# ── 3. Bundle ────────────────────────────────────────────────────────────────
echo
echo "[3/5] bundle"
(cd "$SCRIPTS_DIR" && node aws/build.mjs >/dev/null)
cp "$DEPLOYMENT" "$HERE/dist/deployment.json"
rm -f "$HERE/tick.zip"
(cd "$HERE/dist" && zip -q "$HERE/tick.zip" tick.cjs deployment.json)
echo "      $(du -h "$HERE/tick.zip" | cut -f1)"

# ── 4. Function ──────────────────────────────────────────────────────────────
ENV_JSON="$(python3 - "$ENV_FILE" "$TABLE" "$EVM_NET" "$SN_NET" <<'PY'
import json, sys
wanted = {"STARKNET_RPC_URL", "STARKNET_ACCOUNT_ADDRESS", "STARKNET_PRIVATE_KEY", "EVM_RPC_URL"}
out = {}
for line in open(sys.argv[1]):
    line = line.strip()
    if not line or line.startswith("#") or "=" not in line:
        continue
    k, v = line.split("=", 1)
    if k in wanted and v and "<" not in v:
        out[k] = v
missing = [k for k in ("STARKNET_RPC_URL", "STARKNET_ACCOUNT_ADDRESS", "STARKNET_PRIVATE_KEY") if k not in out]
if missing:
    sys.exit(f"error: {', '.join(missing)} is empty in {sys.argv[1]}")
out.update(RELAY_STATE_TABLE=sys.argv[2], RELAY_EVM=sys.argv[3], RELAY_STARKNET=sys.argv[4])
print(json.dumps({"Variables": out}))
PY
)"

echo
echo "[4/5] Lambda $FN"
if aws lambda get-function --function-name "$FN" --region "$REGION" >/dev/null 2>&1; then
    aws lambda update-function-code --function-name "$FN" --region "$REGION" \
        --zip-file "fileb://$HERE/tick.zip" --query 'LastModified' --output text >/dev/null
    aws lambda wait function-updated --function-name "$FN" --region "$REGION"
    aws lambda update-function-configuration --function-name "$FN" --region "$REGION" \
        --handler tick.handler --timeout "$TIMEOUT" --memory-size "$MEMORY" \
        --environment "$ENV_JSON" --query 'LastModified' --output text >/dev/null
else
    aws lambda create-function --function-name "$FN" --region "$REGION" \
        --runtime nodejs22.x --role "$ROLE_ARN" --handler tick.handler \
        --timeout "$TIMEOUT" --memory-size "$MEMORY" --architectures arm64 \
        --environment "$ENV_JSON" --zip-file "fileb://$HERE/tick.zip" \
        --query 'FunctionArn' --output text >/dev/null
fi
aws lambda wait function-updated --function-name "$FN" --region "$REGION"
# A failed pass is not retried: the next schedule picks the work up anyway,
# and a retry would race the one still running. (Reserved concurrency is not
# set: this account's total quota is at the minimum and refuses it. The
# DynamoDB lock keeps one pass at a time.)
aws lambda put-function-event-invoke-config --function-name "$FN" --region "$REGION" \
    --maximum-retry-attempts 0 --maximum-event-age-in-seconds 60 --output text >/dev/null
echo "      published (timeout ${TIMEOUT}s, ${MEMORY} MB)"

# ── 5. Schedule ──────────────────────────────────────────────────────────────
echo
echo "[5/5] EventBridge $RULE_NAME ($SCHEDULE)"
aws events put-rule --name "$RULE_NAME" --region "$REGION" \
    --schedule-expression "$SCHEDULE" --query 'RuleArn' --output text >/dev/null
FN_ARN="$(aws lambda get-function --function-name "$FN" --region "$REGION" \
    --query 'Configuration.FunctionArn' --output text)"
aws lambda add-permission --function-name "$FN" --region "$REGION" \
    --statement-id "$RULE_NAME" --action lambda:InvokeFunction \
    --principal events.amazonaws.com \
    --source-arn "arn:aws:events:$REGION:$ACCOUNT:rule/$RULE_NAME" --output text >/dev/null 2>&1 || true
aws events put-targets --rule "$RULE_NAME" --region "$REGION" \
    --targets "Id=tick,Arn=$FN_ARN" --query 'FailedEntryCount' --output text

cat <<EOF

Deployed.

  pass     every minute, one at a time
  state    DynamoDB $TABLE
  logs     aws logs tail /aws/lambda/$FN --follow --region $REGION

To pause the relayer without deleting anything:

  aws events disable-rule --name $RULE_NAME --region $REGION
EOF
