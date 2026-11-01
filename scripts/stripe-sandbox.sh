#!/usr/bin/env bash
# Stripe TEST-mode sandbox setup for the $49/month Pro plan. Idempotent; never prints API keys or signing secrets.
#
#   scripts/stripe-sandbox.sh                # create (or find) the product + price, print the env lines
#   scripts/stripe-sandbox.sh --write-env    # also add STRIPE_PRICE_PRO to the gitignored ./.env if it is missing
#
# Requires the Stripe CLI (https://stripe.com/docs/stripe-cli) logged in to a TEST-mode account (`stripe login`, run by you once)
# and jq. It only ever calls the CLI in test mode (no --live), and refuses to continue if the account answers as live mode.
set -euo pipefail

PRODUCT_NAME="${STRIPE_PRODUCT_NAME:-Lumi Pro}"
PRODUCT_KEY="yulona_pro"            # product metadata marker used to find it again
PRICE_LOOKUP="yulona_pro_monthly"   # price lookup key used to find it again
AMOUNT_CENTS="${STRIPE_PRO_AMOUNT_CENTS:-4900}"
CURRENCY="${STRIPE_PRO_CURRENCY:-usd}"
WRITE_ENV=0; [ "${1:-}" = "--write-env" ] && WRITE_ENV=1

command -v stripe >/dev/null || { echo "Stripe CLI not found. Install it: https://stripe.com/docs/stripe-cli" >&2; exit 1; }
command -v jq >/dev/null || { echo "jq not found. Install it (brew install jq)." >&2; exit 1; }

# Logged in? (a cheap read; output discarded so nothing sensitive is printed)
if ! stripe products list --limit 1 >/dev/null 2>&1; then
  echo "The Stripe CLI is not logged in to a test-mode account. Run 'stripe login' yourself, then run this script again." >&2
  exit 1
fi
if [ "$(stripe products list --limit 1 2>/dev/null | jq -r '.data[0].livemode // false')" = "true" ]; then
  echo "Refusing to continue: the CLI answered with live-mode data. Use a test-mode account." >&2
  exit 1
fi

# 1) price by lookup key (idempotent)
price_id="$(stripe prices list --lookup-keys "$PRICE_LOOKUP" --limit 1 2>/dev/null | jq -r '.data[0].id // empty')"

if [ -z "$price_id" ]; then
  # 2) product by metadata marker, else create it
  product_id="$(stripe products list --limit 100 2>/dev/null | jq -r --arg k "$PRODUCT_KEY" '[.data[] | select(.metadata.app_plan == $k and .active)][0].id // empty')"
  if [ -z "$product_id" ]; then
    product_id="$(stripe products create --name "$PRODUCT_NAME" -d "metadata[app_plan]=$PRODUCT_KEY" -d "description=Lumi Pro: monthly AI credits and higher limits" 2>/dev/null | jq -r '.id')"
    echo "Created product $product_id" >&2
  fi
  price_id="$(stripe prices create --product "$product_id" --unit-amount "$AMOUNT_CENTS" --currency "$CURRENCY" \
    -d "recurring[interval]=month" --lookup-key "$PRICE_LOOKUP" -d "metadata[app_plan]=$PRODUCT_KEY" 2>/dev/null | jq -r '.id')"
  echo "Created price $price_id" >&2
else
  echo "Price $price_id already exists (lookup key $PRICE_LOOKUP)." >&2
fi

if [ "$WRITE_ENV" = "1" ]; then
  cd "$(dirname "$0")/.."
  if [ -f .env ] && grep -q '^STRIPE_PRICE_PRO=' .env; then
    echo "./.env already has STRIPE_PRICE_PRO; left unchanged (expected: $price_id)." >&2
  else
    [ -s .env ] && [ -n "$(tail -c1 .env)" ] && printf '\n' >> .env  # file without a trailing newline
    printf 'STRIPE_PRICE_PRO=%s\n' "$price_id" >> .env
    echo "Added STRIPE_PRICE_PRO to ./.env (gitignored)." >&2
  fi
fi

cat <<OUT

# Put these in your local, gitignored .env (never commit them):
STRIPE_PRICE_PRO=$price_id
# STRIPE_SECRET_KEY=sk_test_...   <- Stripe dashboard (test mode) > Developers > API keys. Paste it yourself.
# STRIPE_WEBHOOK_SECRET=whsec_... <- printed by 'stripe listen --print-secret' (below). Paste it yourself.

# Forward webhooks to the local API (keep this running; the secret it prints is the STRIPE_WEBHOOK_SECRET above):
#   stripe listen --events checkout.session.completed,checkout.session.async_payment_succeeded,customer.subscription.created,customer.subscription.updated,customer.subscription.deleted,invoice.paid,invoice.payment_succeeded,invoice.payment_failed \\
#     --forward-to http://localhost:3000/api/v1/webhooks/billing
OUT
