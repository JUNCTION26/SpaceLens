# Privacy

SpaceLens runs in your browser. There are no accounts and no analytics, and the site's own host receives only the request for the static files. This note lists what leaves your device, when, and what stays on it.

## What leaves the device

| Data | Sent to | When | Why |
| --- | --- | --- | --- |
| Your typed or spoken requests, a compact description of the room, and furniture lists | Google Gemini API (`generativelanguage.googleapis.com`) | Only when a Gemini key is set and you use a model feature: describing a room, the design pipeline, creating an object, the agent, vision, shop wording, rendering | The model writes the answer |
| Photos you add in Capture or Vision, pages of a PDF you ask a question about, and a picture of your 3D scene for Render | Google Gemini API | Only when a key is set and you use that feature | The model reads the image |
| Text of the product pages you search or paste | Google Gemini API | Shop, when a key is set | Price and size are read from the listing |
| The product page or search URL, which can include your search words | The public page reader `r.jina.ai`, which fetches the page and, for searches, a DuckDuckGo results page | When you search the shop or paste a store link | Store pages cannot be fetched from a browser directly |
| A request for currency rates (it carries no model or personal data) | `api.frankfurter.dev` | When shop prices are converted | Convert prices to your currency |
| Store product image requests | The store's own image host | When shop results are shown | Show the product picture |
| Your model and key | Nobody | Never sent anywhere by SpaceLens, except that the key itself accompanies calls to Gemini | |

Without a key none of the model rows apply: every model step has a local fallback. Voice input and spoken replies use your browser's speech features; depending on the browser, speech recognition may be processed by the browser vendor.

If the optional API server is configured, model calls go to that server instead and it forwards them to Gemini. See `server/` for what it logs and limits.

Google's handling of API data follows the terms of the key you use. Do not send plans or photos you are not allowed to share.

## What is stored on your device

Everything below is in this site's browser storage and never uploaded by SpaceLens.

| Key | Contents |
| --- | --- |
| `spacelens.model.v1` | The current model (rooms, furniture, measurements, evidence including photo data) |
| `spacelens.settings.v1` | Theme, chosen model and your Gemini key if you saved one |
| `spacelens.forge.library.v1` | Objects you created |
| `spacelens.ai.*` | Model probe results, learned model lists and overrides |
| `spacelens.drawing.<file name>` | A short summary of a PDF you opened (page count, time, up to 50 room labels); the PDF itself is not stored |
| `spacelens:agentMuted`, `spacelens.voice.neural`, `spacelens:navCollapsed`, `spacelens.coach.done.v1`, budget values | Small interface preferences and the budget you typed |
| Session storage `spacelens.ai.cache.*` | Short-lived caches of model answers for this tab |

Uploaded PDFs and photos are processed in the browser. A photo that becomes evidence is kept inside the model in storage.

## Share links

A share link holds the whole model, compressed and encoded, after the `#` in the address. The part after `#` is not sent to the web server, but anyone who has the link can read the model, and it ends up wherever you paste it (chat history, browser history, link previews that read the page). Photos are left out of share links.

A private setup link may carry a Gemini key after `#key=`; the app saves it in the browser and removes it from the address bar immediately. Treat such a link like a password.

## How to clear it

- Remove only the key: open Settings, clear the key field.
- Remove everything: use your browser's site data setting for this site (in most browsers: the padlock or site icon, then Cookies and site data, then Clear). That deletes the model, settings, library and caches in one step.
- Start over inside the app: Settings, Reset to sample room replaces the model with the sample.
