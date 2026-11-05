import type { ChannelKey } from "./api";

/** Ordered "what to paste where" steps shown in the connect sheet. */
export const CHANNEL_STEPS: Record<ChannelKey, { before: string[]; after: string[]; note?: string }> = {
  whatsapp: {
    before: ["In Meta for Developers, create an app and add the WhatsApp product.", "Copy the Phone number ID and an access token from WhatsApp, then API setup.", "Paste them below and connect."],
    after: ["In WhatsApp, then Configuration, paste the Callback URL and Verify token shown here.", "Subscribe to the messages field.", "Send a message to your number to see it arrive in the inbox."],
    note: "Test numbers only message the recipients you allow in Meta. For production you need a verified business number and a permanent system user token.",
  },
  facebook: {
    before: ["Create a Meta app and add Messenger, then link your Facebook Page.", "Generate a Page access token and copy the app secret.", "Paste them below and connect."],
    after: ["In Messenger, then Webhooks, paste the Callback URL and Verify token.", "Subscribe your Page to messages and messaging_postbacks."],
  },
  instagram: {
    before: ["Switch the Instagram account to professional and link it to a Facebook Page.", "In your Meta app, add Instagram messaging and generate an access token.", "Paste it below and connect."],
    after: ["In Instagram, then Webhooks, paste the Callback URL and Verify token.", "Subscribe to messages."],
  },
  telegram: {
    before: ["Open @BotFather in Telegram and send /newbot.", "Copy the bot token it gives you.", "Paste it below and connect."],
    after: ["Click Set up webhook automatically (or register the Webhook URL with Telegram setWebhook and use the Webhook secret as the secret token).", "Send your bot a message to test it."],
  },
  slack: {
    before: ["Create a Slack app and add the chat:write and im:history scopes.", "Install it to your workspace, then copy the bot token and the signing secret.", "Paste them below and connect."],
    after: ["In Event Subscriptions, paste the Webhook URL as the Request URL.", "Subscribe to the message.im bot event (direct messages only; mentions in channels are not answered)."],
  },
};
