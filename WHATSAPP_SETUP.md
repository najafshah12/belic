# Belic WhatsApp assistant setup

The website is static, so a full WhatsApp assistant needs an HTTPS serverless backend. `api/whatsapp.js` is a Vercel Node function that verifies Meta webhook signatures, keeps conversation context and duplicate-message keys in Upstash Redis, asks the OpenAI Responses API for a reply, and sends that reply through WhatsApp Cloud API.

## Required accounts and values

- A Meta Business portfolio, WhatsApp Business Account, and registered business phone number.
- A Meta developer app with WhatsApp webhooks subscribed to the `messages` field.
- An OpenAI API key and an Upstash Redis database.
- A Vercel project connected to this repository for the public HTTPS webhook URL.
- The environment variables listed in `.env.example`.

Set all secrets in Vercel Project Settings → Environment Variables. Do not commit real tokens or put them in browser JavaScript. Set `WHATSAPP_GRAPH_API_VERSION` to a currently supported Graph API version shown in Meta's app/docs. Set the Meta webhook URL to `https://YOUR_DOMAIN/api/whatsapp` and use the same value as `WHATSAPP_VERIFY_TOKEN` in Meta and Vercel. Subscribe the WhatsApp Business Account to the app's `messages` webhook.

After deployment, test the webhook using Meta's test sender and confirm replies arrive in WhatsApp. Add a privacy notice that explains that messages are processed by OpenAI and that conversation context is kept in Redis for up to 30 days.

## References

- [Meta WhatsApp Cloud API](https://www.postman.com/meta/whatsapp-business-platform/documentation/wlk6lh4/whatsapp-cloud-api)
- [Meta webhook setup](https://www.postman.com/meta/whatsapp-business-platform/folder/lboq68h/webhooks)
- [OpenAI Responses API](https://developers.openai.com/api/reference/resources/responses/methods/create)

