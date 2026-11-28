// Witbitz admin client — one file for your SERVER (https://witbitz.chat/docs/sdk#builder-calls). Never ship it in a page.

// spaces/public/sdk/4.4.0/connCatalog.js
var GCAL_PROVIDER = "prov_XE5FdiPdAx881HKs";
var CATALOG = [
  // AN AGENT YOU SEND JOBS TO, not a service you sign in to (the owner, 2026-10-15: "Doesn't grokbot have a connector like
  // other connectors?" → "Yes"). Grok Bot takes MCP servers but offers none; what starts a run from outside is a routine's
  // trigger "When this webhook receives a request": an Endpoint https://grok.com/webhook/automation/<id> and a Signing
  // secret whsec_… — a SIGNED webhook (docs/signed-webhooks.md). Attached through grokRoutine.js; each call is approved.
  { name: "Grok Bot", kind: "webhook", host: "grok.com", desc: "Send a job to one of your Grok Bot routines \u2014 you approve each one.", cat: "Agents", png: "/icons/services/grok-bot.png" },
  // CLAUDE CODE (the owner, 2026-10-21: "Let's do Claude code"): the same kind as Grok Bot — a scheduled task's API trigger
  // (a bearer webhook on api.anthropic.com) takes the job, the run reports back through this Space's MCP address. The card and
  // what the room keeps come from jobAgents.js (docs/job-agents.md).
  { name: "Claude Code", kind: "webhook", host: "api.anthropic.com", desc: "Send a job to a Claude Code task in Anthropic's cloud \u2014 you approve each one.", cat: "Agents", png: "/icons/services/claude-code.png" },
  // AN AGENT THAT COMES TO YOU (the owner, 2026-10-15: "add a muse ai connector like we did for grokbot"). Meta's Muse takes
  // custom MCP connectors (streamable HTTP, a bearer key) but nothing can start a Muse task from outside — no webhook, no
  // public API (docs/outside-agents.md). So it is ONE way: Muse reaches a Space's private assistant through the Sentinel's
  // MCP door (message_member / get_reply), and a recurring Muse task asks that assistant for work. Set up by connectionsSheet.js openMuse.
  { name: "Muse", kind: "agent", host: "meta.ai", desc: "Let Meta's Muse work with this Space's assistant \u2014 it asks for jobs and sends back the results.", cat: "Agents", png: "/icons/services/muse.png" },
  // OpenAI's Dots (the owner, 2026-10-15: "OpenAI new dots bot" → "Do a"): a ChatGPT custom MCP server (name + URL, the key in
  // it). One way for now, as Muse; ChatGPT's MCP Events could push it jobs later (a Sentinel cycle).
  { name: "Dots", kind: "agent", host: "chatgpt.com", desc: "Let your OpenAI dot work with this Space's assistant \u2014 it asks for jobs and sends back the results.", cat: "Agents", png: "/icons/services/dots.png" },
  { name: "Context7", url: "https://mcp.context7.com/mcp", desc: "Up-to-date docs for code libraries.", cat: "Engineering", png: "/icons/services/context7.png" },
  { name: "GitHub", url: "https://api.githubcopilot.com/mcp/", desc: "Repositories, issues and pull requests.", cat: "Engineering", registered: true },
  { name: "Hugging Face", url: "https://huggingface.co/mcp", desc: "Models, datasets and Spaces.", cat: "Engineering" },
  { name: "Jam", url: "https://mcp.jam.dev/mcp", desc: "Bug reports with console and network logs.", cat: "Engineering", png: "/icons/services/jam.png" },
  { name: "Linear", url: "https://mcp.linear.app/mcp", desc: "Issues, projects and cycles.", cat: "Engineering" },
  { name: "Neon", url: "https://mcp.neon.tech/mcp", desc: "Postgres databases and branches.", cat: "Engineering", png: "/icons/services/neon.png" },
  { name: "Sentry", url: "https://mcp.sentry.dev/mcp", desc: "Errors, issues and releases.", cat: "Engineering" },
  { name: "Statsig", url: "https://api.statsig.com/v3/mcp", desc: "Inspect and manage feature gates, experiments, dynamic configs, and metrics.", cat: "Engineering", png: "/icons/services/statsig.png", src: "cursor" },
  { name: "Supabase", url: "https://mcp.supabase.com/mcp", desc: "Databases, tables and edge functions.", cat: "Engineering" },
  { name: "Airtable", url: "https://mcp.airtable.com/mcp", desc: "Bases, tables and records.", cat: "Productivity" },
  { name: "Atlassian", url: "https://mcp.atlassian.com/v1/mcp", desc: "Jira issues and Confluence pages.", cat: "Productivity" },
  { name: "Basecamp", url: "https://mcp.basecamp.com/mcp", desc: "Projects, to-dos and messages.", cat: "Productivity" },
  { name: "ClickUp", url: "https://mcp.clickup.com/mcp", desc: "Tasks, docs and spaces.", cat: "Productivity" },
  { name: "Jotform", url: "https://mcp.jotform.com", desc: "Create and edit forms, then read submissions.", cat: "Productivity", png: "/icons/services/jotform.png", src: "cursor" },
  { name: "monday.com", url: "https://mcp.monday.com/mcp", desc: "Boards, items and updates.", cat: "Productivity", png: "/icons/services/monday.png" },
  { name: "Todoist", url: "https://ai.todoist.net/mcp", desc: "Create, find, and complete tasks and projects.", cat: "Productivity", png: "/icons/services/todoist.png", src: "cursor" },
  { name: "Trello", url: "https://mcp.trello.com/v1", desc: "Boards, lists and cards: create, move and complete, with checklists and due dates.", cat: "Productivity", png: "/icons/services/trello.png", src: "cursor" },
  { name: "Zapier", url: "https://mcp.zapier.com/api/mcp/mcp", desc: "Actions across thousands of apps.", cat: "Productivity" },
  { name: "Coda", url: "https://docs.superhuman.com/apis/mcp", desc: "Search docs, read pages, and update tables.", cat: "Documents", png: "/icons/services/coda.png", src: "cursor" },
  { name: "Craft", url: "https://mcp.craft.do/my/mcp", desc: "Search, create, and update documents and daily notes.", cat: "Documents", png: "/icons/services/craft.png", src: "cursor" },
  { name: "Guru", url: "https://mcp.api.getguru.com/mcp", desc: "Search company knowledge and draft verified answers.", cat: "Documents", png: "/icons/services/guru.png", src: "cursor" },
  { name: "Mem", url: "https://mcp.mem.ai/mcp", desc: "Capture, search, and organize notes and collections.", cat: "Documents", png: "/icons/services/mem.png", src: "cursor" },
  { name: "Notion", url: "https://mcp.notion.com/mcp", desc: "Search, read and write pages.", cat: "Documents" },
  { name: "Readwise", url: "https://mcp2.readwise.io/mcp", desc: "Search highlights and Reader documents, save articles.", cat: "Documents", png: "/icons/services/readwise.png", src: "cursor" },
  { name: "Canva", url: "https://mcp.canva.com/mcp", desc: "Designs, templates and exports.", cat: "Design" },
  { name: "Excalidraw", url: "https://mcp.excalidraw.com/mcp", desc: "Hand-drawn diagrams and sketches.", cat: "Design" },
  { name: "Miro", url: "https://mcp.miro.com/", desc: "Boards, diagrams and sticky notes.", cat: "Design" },
  { name: "Webflow", url: "https://mcp.webflow.com/sse", desc: "Sites, pages and CMS items.", cat: "Design" },
  { name: "Wix", url: "https://mcp.wix.com/mcp", desc: "Sites, stores and bookings.", cat: "Design" },
  { name: "Circleback", url: "https://circleback.ai/api/mcp", desc: "Search meetings, transcripts, action items, and emails.", cat: "Meetings", png: "/icons/services/circleback.png", src: "cursor" },
  { name: "Fathom", url: "https://api.fathom.ai/mcp", desc: "Search meetings and pull transcripts and summaries.", cat: "Meetings", png: "/icons/services/fathom.png", src: "cursor" },
  { name: "Fireflies", url: "https://api.fireflies.ai/mcp", desc: "Search meeting transcripts, summaries, and action items.", cat: "Meetings", png: "/icons/services/fireflies.png", src: "cursor" },
  { name: "Granola", url: "https://mcp.granola.ai/mcp", desc: "Your meeting notes and transcripts.", cat: "Meetings", png: "/icons/services/granola.png" },
  { name: "Otter.ai", url: "https://mcp.otter.ai/mcp", desc: "Search meeting history and pull full transcripts.", cat: "Meetings", png: "/icons/services/otter.png", src: "cursor" },
  { name: "Plaud", url: "https://mcp.plaud.ai/mcp", desc: "Your Plaud recordings: transcripts with speakers, summaries and action items.", cat: "Meetings", png: "/icons/services/plaud.png", src: "cursor" },
  { name: "Read AI", url: "https://api.read.ai/mcp", desc: "Meeting summaries and transcripts.", cat: "Meetings", png: "/icons/services/readai.png" },
  { name: "Calendly", url: "https://mcp.calendly.com/", desc: "Check availability and book, cancel, or reschedule.", cat: "Scheduling", png: "/icons/services/calendly.png", src: "cursor" },
  { name: "Amplemarket", url: "https://mcp.amplemarket.com/mcp", desc: "Search people and companies, enrich leads, run sequences.", cat: "Sales", png: "/icons/services/amplemarket.png", src: "cursor" },
  { name: "Attio", url: "https://mcp.attio.com/mcp", desc: "Search and update CRM records, lists, notes, and tasks.", cat: "Sales", png: "/icons/services/attio.png", src: "cursor" },
  { name: "Clay", url: "https://api.clay.com/v3/mcp", desc: "Enrich people and companies, run AI research agents.", cat: "Sales", png: "/icons/services/clay.png", src: "cursor" },
  { name: "Gong", url: "https://mcp.gong.io/mcp", desc: "Pull account summaries, deal insights, and call briefs.", cat: "Sales", png: "/icons/services/gong.png", src: "cursor" },
  { name: "HubSpot", url: "https://mcp.hubspot.com/", desc: "Contacts, companies, deals and tickets in your CRM.", cat: "Sales", registered: true },
  { name: "Hunter", url: "https://mcp.hunter.io/mcp", desc: "Find and verify emails, discover companies, and save leads.", cat: "Sales", png: "/icons/services/hunter.png", src: "cursor" },
  { name: "Juicebox", url: "https://mcp.juicebox.ai/v1", desc: "Query recruiting analytics, shortlists, and sourcing agents.", cat: "Sales", png: "/icons/services/juicebox.png", src: "cursor" },
  { name: "Outreach", url: "https://api.outreach.io/mcp", desc: "Search sequences, prospects, and Kaia meetings.", cat: "Sales", png: "/icons/services/outreach.png", src: "cursor" },
  { name: "beehiiv", url: "https://mcp.beehiiv.com/mcp", desc: "Your newsletter: posts, subscribers, segments and performance.", cat: "Marketing", png: "/icons/services/beehiiv.png", src: "cursor" },
  { name: "Customer.io", url: "https://mcp.customer.io/mcp", desc: "Build campaigns, manage segments, and query people.", cat: "Marketing", png: "/icons/services/customer-io.png", src: "cursor" },
  { name: "Klaviyo", url: "https://mcp.klaviyo.com/mcp", desc: "Manage profiles, segments, campaigns, and flows.", cat: "Marketing", png: "/icons/services/klaviyo.png", src: "cursor" },
  { name: "MailerLite", url: "https://mcp.mailerlite.com/mcp", desc: "Manage subscribers, groups, campaigns, and automations.", cat: "Marketing", png: "/icons/services/mailerlite.png", src: "cursor" },
  { name: "Meltwater", url: "https://api.meltwater.com/v2/mcp", desc: "Search media and social mentions and pull analytics.", cat: "Marketing", png: "/icons/services/meltwater.png", src: "cursor" },
  { name: "Profound", url: "https://mcp.tryprofound.com/mcp", desc: "Track AI visibility, sentiment, and citations.", cat: "Marketing", png: "/icons/services/profound.png", src: "cursor" },
  { name: "Plain", url: "https://mcp.plain.com/mcp", desc: "Support threads, customers and help articles.", cat: "Customer support", png: "/icons/services/plain.png" },
  { name: "Amplitude", url: "https://mcp.amplitude.com/mcp", desc: "Product analytics and charts.", cat: "Data analytics", png: "/icons/services/amplitude.png" },
  { name: "PostHog", url: "https://mcp.posthog.com/mcp", desc: "Product analytics and SQL, feature flags, experiments, errors and replays.", cat: "Data analytics", png: "/icons/services/posthog-mcp.png", src: "cursor" },
  { name: "Similarweb", url: "https://mcp.similarweb.com", desc: "Analyze website traffic, audiences, and competitors.", cat: "Data analytics", png: "/icons/services/similarweb.png", src: "cursor" },
  { name: "Ashby", url: "https://mcp.ashbyhq.com/mcp/v1", desc: "Search candidates, prep interviews, and manage pipeline tasks.", cat: "Hiring", png: "/icons/services/ashby.png", src: "cursor" },
  { name: "Greenhouse", url: "https://mcp.us.greenhouse.io/mcp", desc: "Search candidates, jobs, and applications, and review scorecards in Greenhouse Recruiting.", cat: "Hiring", png: "/icons/services/greenhouse.png", src: "cursor" },
  { name: "Workable", url: "https://mcp.workable.com/mcp", desc: "Search candidates, move pipelines, and manage HR records.", cat: "Hiring", png: "/icons/services/workable.png", src: "cursor" },
  { name: "Brex", url: "https://api.brex.com/mcp", desc: "Query expenses, receipts, bills, cards, and travel.", cat: "Finance", png: "/icons/services/brex.png", src: "cursor" },
  { name: "Daloopa", url: "https://mcp.daloopa.com/server/mcp", desc: "Pull source-linked fundamentals, KPIs, filings, and prices.", cat: "Finance", png: "/icons/services/daloopa.png", src: "cursor" },
  { name: "Interactive Brokers", url: "https://api.ibkr.com/v1/api/mcp-public", desc: "Review positions, balances, P&L, and draft trade instructions.", cat: "Finance", png: "/icons/services/interactive-brokers.png", src: "cursor" },
  { name: "PayPal", url: "https://mcp.paypal.com/mcp", desc: "Orders, invoices and payments.", cat: "Finance" },
  { name: "Robinhood", url: "https://agent.robinhood.com/mcp/trading", desc: "View portfolios, positions, orders, watchlists, and market data, and trade in a Robinhood Agentic account.", cat: "Finance", png: "/icons/services/robinhood.png", src: "cursor" },
  { name: "S&P Global", url: "https://kfinance.kensho.com/integrations/mcp", desc: "Query S&P Capital IQ financials, prices, and transcripts.", cat: "Finance", png: "/icons/services/sp-global.png", src: "cursor" },
  { name: "Stripe", url: "https://mcp.stripe.com/", desc: "Payments, customers and invoices.", cat: "Finance" },
  { name: "Webull", url: "https://api.webull.com/mcp", desc: "View accounts, positions, orders, watchlists, and market data.", cat: "Finance", png: "/icons/services/webull.png", src: "cursor" },
  { name: "Ahrefs", url: "https://api.ahrefs.com/mcp/mcp", desc: "Research keywords, backlinks, rankings, and site health.", cat: "Research", png: "/icons/services/ahrefs.png", src: "cursor" },
  { name: "Cloudflare Docs", url: "https://docs.mcp.cloudflare.com/mcp", desc: "Cloudflare\u2019s developer documentation.", cat: "Research" },
  { name: "Exa", url: "https://mcp.exa.ai/mcp", desc: "Web search and page contents.", cat: "Research", png: "/icons/services/exa.png" },
  { name: "TinyFish", url: "https://agent.tinyfish.ai/mcp", desc: "Web automations, search and clean page content in remote browsers.", cat: "Research", png: "/icons/services/tinyfish.png", src: "cursor" },
  // FROM GROK BOT'S PLUGIN MARKETPLACE (github.com/xai-org/plugin-marketplace, read 2026-11-16; the owner: "look at grokbot opensource
  // connections - update our connections and add missing ones"): each address passed tools/conn-catalog/probe.mjs's sign-in steps
  // that day (GoDaddy answers without one — domain suggestions and availability only). Descriptions are ours; no logos copied.
  // Left out: the 13 that register no outside app (HubSpot, Zoom, Google's, X, DocuSign, Shopify…), the 22 that refuse Witbitz's
  // registration (Figma, Vercel, Netlify, Railway, Intercom, Square…), Stable (its tools need the person's own API key), TikTok Ads
  // (no sign-in method), and every address behind Cursor's or Grok's own gateway. Navan was removed: it now refuses registration.
  { name: "Axiom", url: "https://mcp.axiom.co/mcp", desc: "Logs and metrics: queries, dashboards and monitors.", cat: "Engineering", png: "/icons/services/axiom.png" },
  { name: "Clerk", url: "https://mcp.clerk.com/mcp", desc: "Your app's users, organizations and sign-in.", cat: "Engineering" },
  { name: "Cloudflare", url: "https://mcp.cloudflare.com/mcp", desc: "Workers, DNS and your Cloudflare account.", cat: "Engineering" },
  { name: "Expo", url: "https://mcp.expo.dev/mcp", desc: "Build, test and ship iOS and Android apps.", cat: "Engineering" },
  { name: "GoDaddy", url: "https://api.godaddy.com/v1/domains/mcp", desc: "Domain name ideas and whether a name is free.", cat: "Engineering" },
  { name: "Pi Security", url: "https://mcp.pi.security/mcp", desc: "Security findings, posture and how to fix them.", cat: "Engineering", png: "/icons/services/pi-security.png" },
  { name: "RingCentral Team Messaging", url: "https://mcp.labs.ringcentral.com/ringex/v1.1.0/team-chat", desc: "Team chats and messages in RingCentral.", cat: "Productivity", png: "/icons/services/ringcentral-team-messaging.png" },
  { name: "Framer", url: "https://mcp.framer.com/mcp", desc: "Pages and content of a Framer website.", cat: "Design" },
  { name: "HTML/CSS to Image", url: "https://mcp.hcti.io", desc: "Turn HTML or a web page into an image or a PDF.", cat: "Design", png: "/icons/services/html-css-to-image.png" },
  { name: "VideoGen", url: "https://mcp.videogen.io/mcp", desc: "Make a video from text, images or a script.", cat: "Design", png: "/icons/services/videogen.png" },
  { name: "Cal.com", url: "https://mcp.cal.com/mcp", desc: "Availability, bookings and event types.", cat: "Scheduling" },
  // GOOGLE CALENDAR (2026-11-23, docs/google-calendar-verification.md): Google's own Calendar MCP server takes no self-registered
  // app — Witbitz files its own client (project witbitz-spaces-calendar, scope calendar.events alone) with the Sentinel, and the
  // sign-in comes back through the broker's callback (connections.js mcpRedirectFor). Until Google verifies the client, only its
  // test users can sign in.
  // ⛔ OUT OF THE CATALOG until Google makes the Calendar MCP server generally available (2026-11-23): it answers only projects in
  // the Workspace Developer Preview Program, which takes only Workspace-domain accounts, and its terms keep preview features out of
  // public apps. Everything else is in place (the filed client, st51, the broker's callback) — put this line back then:
  // { name: "Google Calendar", url: "https://calendarmcp.googleapis.com/mcp/v1", desc: "Read your events and, when you approve, add or change them.", cat: "Scheduling", registered: true },
  // GOOGLE CALENDAR ON GOOGLE'S REGULAR CALENDAR API (2026-11-23; owner: "it did not sync automatically" → this): kind 'oauth' = the
  // Sentinel's own Google sign-in (custody.mjs oauthStart: offline access, a refresh token it renews itself) with Witbitz's app filed
  // under `tenant` as `provider`; the connection reaches `host`. Reads run without asking, a change is a card (connSpaces readsAutoFor).
  { name: "Google Calendar", kind: "oauth", tenant: "t_815e94f68944437592310c0b80861cd9", provider: GCAL_PROVIDER, host: "www.googleapis.com", reads: "auto", desc: "Read your events and, when you approve, add or change them.", cat: "Scheduling" },
  { name: "Helena", url: "https://agent.enrichlabs.ai/api/mcp", desc: "An AI marketer for SEO, ads, social and email campaigns.", cat: "Marketing", png: "/icons/services/helena.png" },
  { name: "Omneky", url: "https://mcp.omneky.com/mcp", desc: "Ad campaigns, their results and new creatives.", cat: "Marketing", png: "/icons/services/omneky.png" },
  { name: "Quo", url: "https://mcp.quo.com/mcp", desc: "Business texts, calls and contacts.", cat: "Customer support", png: "/icons/services/quo.png" },
  { name: "RingCentral Phone", url: "https://mcp.labs.ringcentral.com/ringex/phone", desc: "Calls, voicemail and texts in RingCentral.", cat: "Customer support", png: "/icons/services/ringcentral-phone.png" },
  { name: "Finary", url: "https://public-api.finary.com/mcp", desc: "Your investments, accounts and net worth.", cat: "Finance", png: "/icons/services/finary.png" },
  { name: "Gusto", url: "https://mcp.api.gusto.com/", desc: "Payroll, employees and benefits.", cat: "Finance" },
  { name: "Firecrawl", url: "https://mcp.firecrawl.dev/v2/mcp-oauth", desc: "Scrape, crawl and search websites as clean text.", cat: "Research", png: "/icons/services/firecrawl.png" },
  { name: "Octen", url: "https://mcp.octen.ai/mcp", desc: "Web and news search, and page extraction.", cat: "Research", png: "/icons/services/octen.png" },
  { name: "Tavily", url: "https://mcp.tavily.com/mcp", desc: "Web search, page extraction and research.", cat: "Research", png: "/icons/services/tavily.png" },
  // SINCE STANDING SENTINEL st33 (2026-11-16): Netlify (its client id is a 447-character token — the Sentinel took 400 at most) and
  // the services that refuse a web app's self-registration but take the app as its OWN client (client ID metadata documents —
  // /mcp-client.json). Vercel signed in end to end on the owner's phone; Railway, Typeform and Upwork showed their consent page.
  { name: "Netlify", url: "https://mcp.netlify.com/mcp", desc: "Sites, deploys and build logs.", cat: "Engineering" },
  { name: "Railway", url: "https://mcp.railway.com", desc: "Services, deployments and logs.", cat: "Engineering" },
  { name: "Vercel", url: "https://mcp.vercel.com", desc: "Deployments, build logs and domains.", cat: "Engineering" },
  { name: "Typeform", url: "https://api.typeform.com/mcp", desc: "Forms and their responses.", cat: "Productivity" },
  { name: "Upwork", url: "https://mcp.upwork.com/mcp", desc: "Jobs, proposals and contracts.", cat: "Hiring" },
  // FROM THE MONTHLY CHECK (2026-11-16, owner: "yes"): eight that newly pass the sign-in steps, from Cursor's plugins and Grok Bot's
  // marketplace; their marks found by the same check (tools/conn-catalog/icons.mjs). Descriptions are ours.
  { name: "Mixpanel", url: "https://mcp.mixpanel.com/mcp", desc: "Events, funnels, retention and dashboards.", cat: "Data analytics" },
  { name: "Metricool", url: "https://ai.metricool.com/mcp", desc: "Plan and publish social posts, and their results.", cat: "Marketing", png: "/icons/services/metricool.png" },
  { name: "Squarespace", url: "https://mcp.squarespace.com/mcp", desc: "Business name ideas and domains: availability and price.", cat: "Design" },
  { name: "Runta", url: "https://mcp.runta.com/mcp", desc: "Run lasting agent runtimes: ports, checkpoints and images.", cat: "Engineering", png: "/icons/services/runta.png" },
  { name: "OnePay", url: "https://mcp.onepay.com", desc: "Balances and spending across your OnePay accounts.", cat: "Finance", png: "/icons/services/onepay.png" },
  { name: "Questrade", url: "https://mcp.questrade.com/v1/brokerage/mcp", desc: "Your portfolio and live market data.", cat: "Finance", png: "/icons/services/questrade.png" },
  { name: "Engine", url: "https://mcp.engine.com/mcp", desc: "Find and book hotels, change or cancel stays.", cat: "Travel", png: "/icons/services/engine.png" },
  { name: "Eight Sleep", url: "https://public-api.8slp.net/mcp", desc: "Your sleep scores and your Pod's temperature.", cat: "Health" },
  { name: "AgentMail", url: "https://mcp.agentmail.to/mcp", desc: "Email inboxes for your assistant.", cat: "Email", png: "/icons/services/agentmail.png" },
  // GMAIL BY FORWARDING (the owner, 2026-11-21: Nylas's verified Google app — the only way to read Gmail without Google's yearly
  // assessment — was "too expensive" → "lets do this forward connector to gmail"). Not a sign-in: Gmail forwards what the person
  // chooses to the Space's own address (Witbitz Mail, mailShare.js — received and sealed in the Sentinel). kind 'mail': no MCP address;
  // connectionsSheet.js opens the Space's Mail card with Gmail's steps. (Reading through Nylas is built and kept: nylas.mjs.)
  { name: "Gmail", kind: "mail", host: "mail.google.com", desc: "Forward the mail you choose into a Space of your own \u2014 the assistant reads it when you ask.", cat: "Email" }
];

// spaces/public/sdk/4.4.0/cbor.js
var MAX_LEN = 1 << 22;
function decode(bytes) {
  const b = toBytes(bytes);
  const [value, off] = readItem(b, 0);
  if (value === BREAK) throw new Error("cbor: stray break byte");
  if (off !== b.length) throw new Error(`cbor: ${b.length - off} trailing bytes`);
  return value;
}
function toBytes(x) {
  if (x instanceof Uint8Array) return x;
  if (x instanceof ArrayBuffer) return new Uint8Array(x);
  if (ArrayBuffer.isView(x)) return new Uint8Array(x.buffer, x.byteOffset, x.byteLength);
  throw new Error("cbor: expected bytes");
}
function need(b, off, n) {
  if (n < 0 || off + n > b.length) throw new Error("cbor: truncated");
  return off + n;
}
function readHead(b, off) {
  need(b, off, 1);
  const ib = b[off];
  const major = ib >> 5;
  const ai = ib & 31;
  if (ai < 24) return [major, ai, off + 1];
  if (ai === 24) {
    need(b, off + 1, 1);
    return [major, b[off + 1], off + 2];
  }
  if (ai === 25) {
    need(b, off + 1, 2);
    return [major, b[off + 1] << 8 | b[off + 2], off + 3];
  }
  if (ai === 26) {
    need(b, off + 1, 4);
    const v = (b[off + 1] << 24 | b[off + 2] << 16 | b[off + 3] << 8 | b[off + 4]) >>> 0;
    return [major, v, off + 5];
  }
  if (ai === 27) {
    need(b, off + 1, 8);
    let v = 0;
    for (let i = 1; i <= 8; i++) v = v * 256 + b[off + i];
    if (!Number.isSafeInteger(v)) throw new Error("cbor: 64-bit value exceeds safe integer range");
    return [major, v, off + 9];
  }
  if (ai === 31) throw new Error("cbor: indefinite length handled by the caller");
  throw new Error(`cbor: reserved additional information ${ai}`);
}
var BREAK = /* @__PURE__ */ Symbol("cbor-break");
function readChunked(b, off, major, depth) {
  const parts = [];
  let total = 0;
  let p = off;
  for (; ; ) {
    need(b, p, 1);
    const head2 = b[p];
    if (head2 === 255) {
      p += 1;
      break;
    }
    if (head2 >> 5 !== major || (head2 & 31) === 31) {
      throw new Error("cbor: indefinite-length string contains a chunk of the wrong kind");
    }
    const [chunk, next] = readItem(b, p, depth + 1);
    p = next;
    const bytes = major === 2 ? chunk : new TextEncoder().encode(chunk);
    total += bytes.length;
    if (total > MAX_LEN) throw new Error("cbor: indefinite-length string too large");
    parts.push(bytes);
  }
  const out = concat(...parts);
  return [major === 2 ? out : new TextDecoder("utf-8", { fatal: true }).decode(out), p];
}
function readItem(b, off, depth = 0) {
  if (depth > 16) throw new Error("cbor: nesting too deep");
  need(b, off, 1);
  const ib = b[off];
  const major0 = ib >> 5;
  if ((ib & 31) === 31) {
    if (major0 === 7) return [BREAK, off + 1];
    if (major0 === 2 || major0 === 3) return readChunked(b, off + 1, major0, depth);
    if (major0 === 4 || major0 === 5) {
      const isMap = major0 === 5;
      const arr = [];
      const map = /* @__PURE__ */ new Map();
      let p2 = off + 1;
      let n = 0;
      for (; ; ) {
        const [k, n1] = readItem(b, p2, depth + 1);
        p2 = n1;
        if (k === BREAK) break;
        if (++n > MAX_LEN) throw new Error("cbor: indefinite-length collection too large");
        if (!isMap) {
          arr.push(k);
          continue;
        }
        const [v, n2] = readItem(b, p2, depth + 1);
        p2 = n2;
        if (v === BREAK) throw new Error("cbor: indefinite-length map ended between a key and its value");
        if (map.has(k)) throw new Error("cbor: duplicate map key");
        map.set(k, v);
      }
      return [isMap ? map : arr, p2];
    }
    throw new Error(`cbor: indefinite length is not valid for major type ${major0}`);
  }
  const [major, value, p] = readHead(b, off);
  switch (major) {
    case 0:
      return [value, p];
    case 1:
      return [-1 - value, p];
    case 2: {
      if (value > MAX_LEN) throw new Error("cbor: byte string too large");
      const end = need(b, p, value);
      return [b.slice(p, end), end];
    }
    case 3: {
      if (value > MAX_LEN) throw new Error("cbor: text string too large");
      const end = need(b, p, value);
      return [new TextDecoder("utf-8", { fatal: true }).decode(b.subarray(p, end)), end];
    }
    case 4: {
      if (value > MAX_LEN) throw new Error("cbor: array too long");
      const out = [];
      let q = p;
      for (let i = 0; i < value; i++) {
        const [v, n] = readItem(b, q, depth + 1);
        if (v === BREAK) throw new Error("cbor: break inside a definite-length array");
        out.push(v);
        q = n;
      }
      return [out, q];
    }
    case 5: {
      if (value > MAX_LEN) throw new Error("cbor: map too large");
      const out = /* @__PURE__ */ new Map();
      let q = p;
      for (let i = 0; i < value; i++) {
        const [k, n1] = readItem(b, q, depth + 1);
        const [v, n2] = readItem(b, n1, depth + 1);
        if (k === BREAK || v === BREAK) throw new Error("cbor: break inside a definite-length map");
        if (out.has(k)) throw new Error("cbor: duplicate map key");
        out.set(k, v);
        q = n2;
      }
      return [out, q];
    }
    case 6: {
      const [v, n] = readItem(b, p, depth + 1);
      return [v, n];
    }
    case 7:
      if (value === 20) return [false, p];
      if (value === 21) return [true, p];
      if (value === 22) return [null, p];
      if (value === 23) return [void 0, p];
      throw new Error(`cbor: unsupported simple/float value ${value}`);
    default:
      throw new Error("cbor: unreachable");
  }
}
function head(major, value) {
  if (value < 24) return Uint8Array.of(major << 5 | value);
  if (value < 256) return Uint8Array.of(major << 5 | 24, value);
  if (value < 65536) return Uint8Array.of(major << 5 | 25, value >> 8, value & 255);
  if (value < 4294967296) {
    return Uint8Array.of(major << 5 | 26, value >>> 24 & 255, value >>> 16 & 255, value >>> 8 & 255, value & 255);
  }
  throw new Error("cbor: length too large to encode");
}
function encodeBytes(u8) {
  const b = toBytes(u8);
  return concat(head(2, b.length), b);
}
function encodeText(s) {
  const b = new TextEncoder().encode(String(s));
  return concat(head(3, b.length), b);
}
function encodeArray(items) {
  return concat(head(4, items.length), ...items);
}
function concat(...parts) {
  let n = 0;
  for (const p of parts) n += p.length;
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

// spaces/public/sdk/4.4.0/x509.js
var TAG = { INT: 2, BITSTRING: 3, OID: 6, SEQ: 48, UTCTIME: 23, GENTIME: 24 };
var SIG_OIDS = /* @__PURE__ */ new Map([
  ["1.2.840.10045.4.3.2", { hash: "SHA-256" }],
  ["1.2.840.10045.4.3.3", { hash: "SHA-384" }],
  ["1.2.840.10045.4.3.4", { hash: "SHA-512" }]
]);
var CURVE_OIDS = /* @__PURE__ */ new Map([
  ["1.2.840.10045.3.1.7", { curve: "P-256", size: 32 }],
  ["1.3.132.0.34", { curve: "P-384", size: 48 }],
  ["1.3.132.0.35", { curve: "P-521", size: 66 }]
]);
function readTLV(b, off) {
  if (off + 2 > b.length) throw new Error("der: truncated tag");
  const tag = b[off];
  if ((tag & 31) === 31) throw new Error("der: multi-byte tags not supported");
  let p = off + 1;
  let len = b[p++];
  if (len & 128) {
    const n = len & 127;
    if (n === 0) throw new Error("der: indefinite length is not valid DER");
    if (n > 4) throw new Error("der: length too large");
    if (p + n > b.length) throw new Error("der: truncated length");
    len = 0;
    for (let i = 0; i < n; i++) len = len * 256 + b[p++];
  }
  const contentEnd = p + len;
  if (contentEnd > b.length) throw new Error("der: truncated content");
  return { tag, start: off, contentStart: p, contentEnd };
}
function expect(b, off, tag, what) {
  const t = readTLV(b, off);
  if (t.tag !== tag) throw new Error(`der: expected ${what} (tag 0x${tag.toString(16)}), got 0x${t.tag.toString(16)}`);
  return t;
}
function children(b, t) {
  const out = [];
  let p = t.contentStart;
  while (p < t.contentEnd) {
    const c = readTLV(b, p);
    out.push(c);
    p = c.contentEnd;
  }
  return out;
}
function oidString(b, t) {
  const c = b.subarray(t.contentStart, t.contentEnd);
  if (!c.length) throw new Error("der: empty OID");
  const parts = [Math.floor(c[0] / 40), c[0] % 40];
  let v = 0;
  for (let i = 1; i < c.length; i++) {
    v = v * 128 + (c[i] & 127);
    if (!(c[i] & 128)) {
      parts.push(v);
      v = 0;
    }
  }
  return parts.join(".");
}
function parseTime(b, t) {
  const s = String.fromCharCode(...b.subarray(t.contentStart, t.contentEnd));
  let m;
  if (t.tag === TAG.UTCTIME) {
    m = /^(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})Z$/.exec(s);
    if (!m) throw new Error("der: bad UTCTime");
    const yy = Number(m[1]);
    return Date.UTC(yy >= 50 ? 1900 + yy : 2e3 + yy, Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6]));
  }
  if (t.tag === TAG.GENTIME) {
    m = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})Z$/.exec(s);
    if (!m) throw new Error("der: bad GeneralizedTime");
    return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6]));
  }
  throw new Error("der: unsupported time tag");
}
function derSigToRaw(der, size) {
  const b = der instanceof Uint8Array ? der : new Uint8Array(der);
  const seq = expect(b, 0, TAG.SEQ, "signature SEQUENCE");
  const [rT, sT] = children(b, seq);
  if (!rT || !sT || rT.tag !== TAG.INT || sT.tag !== TAG.INT) throw new Error("der: bad ECDSA signature");
  const out = new Uint8Array(size * 2);
  for (const [i, t] of [[0, rT], [1, sT]]) {
    let v = b.subarray(t.contentStart, t.contentEnd);
    while (v.length > 1 && v[0] === 0) v = v.subarray(1);
    if (v.length > size) throw new Error("der: ECDSA integer too large for curve");
    out.set(v, i * size + (size - v.length));
  }
  return out;
}
function parseCertificate(der) {
  const b = der instanceof Uint8Array ? der : new Uint8Array(der);
  const cert = expect(b, 0, TAG.SEQ, "Certificate");
  const [tbsT, algT, sigT] = children(b, cert);
  if (!tbsT || !algT || !sigT) throw new Error("der: Certificate needs 3 fields");
  if (sigT.tag !== TAG.BITSTRING) throw new Error("der: signatureValue must be a BIT STRING");
  const sigAlgOid = oidString(b, expect(b, algT.contentStart, TAG.OID, "signature algorithm"));
  const sigAlg = SIG_OIDS.get(sigAlgOid);
  if (!sigAlg) throw new Error(`der: unsupported signature algorithm ${sigAlgOid}`);
  if (b[sigT.contentStart] !== 0) throw new Error("der: signature BIT STRING has unused bits");
  const sigDer = b.subarray(sigT.contentStart + 1, sigT.contentEnd);
  const kids = children(b, tbsT);
  const base = kids[0] && kids[0].tag === 160 ? 1 : 0;
  const [serialT, innerAlgT, issuerT, validityT, subjectT, spkiT] = kids.slice(base, base + 6);
  if (!serialT || !innerAlgT || !issuerT || !validityT || !subjectT || !spkiT) throw new Error("der: malformed tbsCertificate");
  const innerOid = oidString(b, expect(b, innerAlgT.contentStart, TAG.OID, "inner signature algorithm"));
  if (innerOid !== sigAlgOid) throw new Error("der: signature algorithm mismatch between tbs and certificate");
  const [nbT, naT] = children(b, validityT);
  if (!nbT || !naT) throw new Error("der: malformed validity");
  const [spkiAlgT] = children(b, spkiT);
  const spkiAlgKids = children(b, spkiAlgT);
  if (spkiAlgKids.length < 2) throw new Error("der: SPKI algorithm needs a curve parameter");
  const keyOid = oidString(b, spkiAlgKids[0]);
  if (keyOid !== "1.2.840.10045.2.1") throw new Error(`der: not an EC public key (${keyOid})`);
  const curveOid = oidString(b, spkiAlgKids[1]);
  const curve = CURVE_OIDS.get(curveOid);
  if (!curve) throw new Error(`der: unsupported curve ${curveOid}`);
  let isCA = false;
  for (const k of kids.slice(base + 6)) {
    if (k.tag !== 163) continue;
    for (const ext of children(b, children(b, k)[0] || k)) {
      const extKids = children(b, ext);
      if (!extKids.length || oidString(b, extKids[0]) !== "2.5.29.19") continue;
      const octet = extKids[extKids.length - 1];
      const bcSeq = readTLV(b, octet.contentStart);
      const bcKids = children(b, bcSeq);
      isCA = !!(bcKids[0] && bcKids[0].tag === 1 && b[bcKids[0].contentStart] !== 0);
    }
  }
  return {
    tbs: b.subarray(tbsT.start, tbsT.contentEnd),
    sig: derSigToRaw(sigDer, curve.size),
    sigHash: sigAlg.hash,
    spki: b.slice(spkiT.start, spkiT.contentEnd),
    // copy: this is handed to WebCrypto, which wants its own buffer
    curve: curve.curve,
    size: curve.size,
    issuer: b.subarray(issuerT.start, issuerT.contentEnd),
    subject: b.subarray(subjectT.start, subjectT.contentEnd),
    notBefore: parseTime(b, nbT),
    notAfter: parseTime(b, naT),
    isCA
  };
}
function bytesEqual(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a[i] ^ b[i];
  return d === 0;
}
async function importSpki(cert) {
  return crypto.subtle.importKey("spki", cert.spki, { name: "ECDSA", namedCurve: cert.curve }, false, ["verify"]);
}
async function verifyChain(chainDer, { now = Date.now() } = {}) {
  if (!Array.isArray(chainDer) || chainDer.length < 2) throw new Error("chain: need an anchor and at least one certificate");
  const certs = chainDer.map((d, i) => {
    try {
      return parseCertificate(d);
    } catch (e) {
      throw new Error(`chain: certificate ${i} unparseable: ${e.message}`);
    }
  });
  for (let i = 1; i < certs.length; i++) {
    const child = certs[i];
    const parent = certs[i - 1];
    if (!bytesEqual(child.issuer, parent.subject)) throw new Error(`chain: certificate ${i} was not issued by certificate ${i - 1}`);
    if (i > 1 && !parent.isCA) throw new Error(`chain: certificate ${i - 1} signs but is not a CA`);
    if (now < child.notBefore) throw new Error(`chain: certificate ${i} is not yet valid`);
    if (now > child.notAfter) throw new Error(`chain: certificate ${i} has expired`);
    const ok = await crypto.subtle.verify({ name: "ECDSA", hash: child.sigHash }, await importSpki(parent), child.sig, child.tbs);
    if (!ok) throw new Error(`chain: certificate ${i} has a bad signature`);
  }
  return certs[certs.length - 1];
}

// spaces/public/sdk/4.4.0/nitroVerify.js
var NITRO_ROOT_G1_B64 = "MIICETCCAZagAwIBAgIRAPkxdWgbkK/hHUbMtOTn+FYwCgYIKoZIzj0EAwMwSTELMAkGA1UEBhMCVVMxDzANBgNVBAoMBkFtYXpvbjEMMAoGA1UECwwDQVdTMRswGQYDVQQDDBJhd3Mubml0cm8tZW5jbGF2ZXMwHhcNMTkxMDI4MTMyODA1WhcNNDkxMDI4MTQyODA1WjBJMQswCQYDVQQGEwJVUzEPMA0GA1UECgwGQW1hem9uMQwwCgYDVQQLDANBV1MxGzAZBgNVBAMMEmF3cy5uaXRyby1lbmNsYXZlczB2MBAGByqGSM49AgEGBSuBBAAiA2IABPwCVOumCMHzaHDimtqQvkY4MpJzbolL//Zy2YlES1BR5TSksfbb48C8WBoyt7F2Bw7eEtaaP+ohG2bnUs990d0JX28TcPQXCEPZ3BABIeTPYwEoCWZEh8l5YoQwTcU/9KNCMEAwDwYDVR0TAQH/BAUwAwEB/zAdBgNVHQ4EFgQUkCW1DdkFR+eWw5b6cp3PmanfS5YwDgYDVR0PAQH/BAQDAgGGMAoGCCqGSM49BAMDA2kAMGYCMQCjfy+Rocm9Xue4YnwWmNJVA44fA0P5W2OpYow9OYCVRaEevL8uO1XYru5xtMPWrfMCMQCi85sWBbJwKKXdS6BptQFuZbT73o/gBh1qUxl/nNr12UO8Yfwr6wPLb+6NIwLz3/Y=";
var COSE_ALG_ES384 = -35;
var MAX_DOC = 1 << 20;
var MAX_FIELD = 1024;
var MAX_CABUNDLE = 8;
function b64ToBytes(b643) {
  const s = String(b643).replace(/-/g, "+").replace(/_/g, "/").replace(/\s+/g, "");
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
var toHex = (u8) => Array.from(u8, (b) => b.toString(16).padStart(2, "0")).join("");
var isBytes = (x) => x instanceof Uint8Array;
var optBytes = (m, k) => {
  const v = m.get(k);
  if (v === null || v === void 0) return null;
  if (!isBytes(v) || v.length > MAX_FIELD) throw new Error(`attestation: bad ${k}`);
  return v.length ? v : null;
};
function sigStructure(protectedBytes, payloadBytes) {
  return encodeArray([
    encodeText("Signature1"),
    encodeBytes(protectedBytes),
    encodeBytes(new Uint8Array(0)),
    // external_aad — always empty for Nitro
    encodeBytes(payloadBytes)
  ]);
}
function parseDocument(payloadBytes) {
  const m = decode(payloadBytes);
  if (!(m instanceof Map)) throw new Error("attestation: payload is not a map");
  const moduleId = m.get("module_id");
  if (typeof moduleId !== "string" || !moduleId || moduleId.length > MAX_FIELD) throw new Error("attestation: bad module_id");
  const digest = m.get("digest");
  if (digest !== "SHA384") throw new Error(`attestation: unexpected digest ${digest}`);
  const timestamp = m.get("timestamp");
  if (typeof timestamp !== "number" || !(timestamp > 0)) throw new Error("attestation: bad timestamp");
  const pcrsMap = m.get("pcrs");
  if (!(pcrsMap instanceof Map) || pcrsMap.size < 1 || pcrsMap.size > 32) throw new Error("attestation: bad pcrs");
  const pcrs = {};
  for (const [k, v] of pcrsMap) {
    if (!Number.isInteger(k) || k < 0 || k > 31) throw new Error("attestation: bad PCR index");
    if (!isBytes(v) || v.length !== 32 && v.length !== 48 && v.length !== 64) throw new Error(`attestation: bad PCR${k}`);
    pcrs[k] = toHex(v);
  }
  const certificate = m.get("certificate");
  if (!isBytes(certificate) || !certificate.length) throw new Error("attestation: missing certificate");
  const cabundle = m.get("cabundle");
  if (!Array.isArray(cabundle) || !cabundle.length || cabundle.length > MAX_CABUNDLE) throw new Error("attestation: bad cabundle");
  for (const c of cabundle) if (!isBytes(c) || !c.length) throw new Error("attestation: bad cabundle entry");
  return {
    moduleId,
    timestamp,
    digest,
    pcrs,
    certificate,
    cabundle,
    publicKey: optBytes(m, "public_key"),
    userData: optBytes(m, "user_data"),
    nonce: optBytes(m, "nonce")
  };
}
var MAX_PIN_SET = 2;
function acceptedSet(pin, label = "pin") {
  const list = (Array.isArray(pin) ? pin : [pin]).map((h) => String(h).toLowerCase());
  if (!list.length) throw new Error(`attestation: ${label} pins an empty set \u2014 that is not a check`);
  if (list.length > MAX_PIN_SET) throw new Error(`attestation: ${label} pins ${list.length} values; at most ${MAX_PIN_SET} (a rollover is {outgoing, incoming})`);
  return list;
}
async function verifyAttestation(cose, { root, now = Date.now(), maxAgeMs = 0, expectedPCRs = null, nonce = null, atDocTime = false, clockBoundMs = 0 } = {}) {
  const raw = cose instanceof Uint8Array ? cose : new Uint8Array(cose);
  if (!raw.length || raw.length > MAX_DOC) throw new Error("attestation: implausible document size");
  const cs = decode(raw);
  if (!Array.isArray(cs) || cs.length !== 4) throw new Error("attestation: not a COSE_Sign1 structure");
  const [protectedBytes, unprotected, payloadBytes, signature] = cs;
  if (!isBytes(protectedBytes) || !isBytes(payloadBytes) || !isBytes(signature)) throw new Error("attestation: malformed COSE_Sign1");
  if (!(unprotected instanceof Map)) throw new Error("attestation: malformed COSE header");
  const ph = protectedBytes.length ? decode(protectedBytes) : /* @__PURE__ */ new Map();
  if (!(ph instanceof Map) || ph.get(1) !== COSE_ALG_ES384) throw new Error("attestation: protected header must specify ES384");
  if (signature.length !== 96) throw new Error("attestation: ES384 signature must be 96 bytes");
  const doc = parseDocument(payloadBytes);
  const anchor = root ? root instanceof Uint8Array ? root : new Uint8Array(root) : b64ToBytes(NITRO_ROOT_G1_B64);
  const leaf = await verifyChain([anchor, ...doc.cabundle.slice(1), doc.certificate], { now: atDocTime && Number.isFinite(doc.timestamp) ? doc.timestamp : now });
  const ok = await crypto.subtle.verify(
    { name: "ECDSA", hash: "SHA-384" },
    await importSpki(leaf),
    signature,
    sigStructure(protectedBytes, payloadBytes)
  );
  if (!ok) throw new Error("attestation: COSE signature does not verify under the leaf certificate");
  if (atDocTime && clockBoundMs > 0 && Number.isFinite(doc.timestamp) && Math.abs(now - doc.timestamp) > clockBoundMs) {
    const h = Math.round(Math.abs(now - doc.timestamp) / 36e5);
    const e = new Error(`attestation: this device's clock is about ${h} hour${h === 1 ? "" : "s"} off the enclave's \u2014 check the date and time settings`);
    e.code = "clock_off";
    throw e;
  }
  if (maxAgeMs > 0 && now - doc.timestamp > maxAgeMs) {
    throw new Error(`attestation: document is ${Math.round((now - doc.timestamp) / 1e3)}s old`);
  }
  if (nonce) {
    const want = typeof nonce === "string" ? new TextEncoder().encode(nonce) : new Uint8Array(nonce);
    if (!doc.nonce || !bytesEqual(doc.nonce, want)) throw new Error("attestation: nonce does not match the challenge");
  }
  if (expectedPCRs) {
    const wanted = Object.entries(expectedPCRs);
    if (!wanted.length) throw new Error("attestation: expectedPCRs was empty \u2014 that is not a check");
    for (const [idx, pin] of wanted) {
      const n = Number(idx);
      if (!Number.isInteger(n) || n < 0 || n > 31) {
        throw new Error(`attestation: expectedPCRs key ${JSON.stringify(idx)} is not a PCR index (0-31)`);
      }
      const accepted = acceptedSet(pin, `PCR${idx}`);
      const got = doc.pcrs[n];
      if (!got) throw new Error(`attestation: PCR${idx} is absent from the document`);
      if (!accepted.includes(got)) throw new Error(`attestation: PCR${idx} mismatch
  expected ${accepted.join(" or ")}
  got      ${got}`);
    }
  }
  return { ok: true, ...doc, leaf };
}

// spaces/public/sdk/4.4.0/sentinelRelease.js
var BUILD_ENCLAVE_PCR0 = Object.freeze([
  "c6a8cbd0c05d8e003e75b266f1dde2a6426b7cd61f845e4b128e59063e40968b44f30d934bbe1925582fe33bbdd0b1d7",
  "f490096d57e4287146e8b8d7bf4c75f423984ca52199efab0ee8684fbee6cfe6ab82c72d54f05a38f24a0d4ad6e2f557",
  "41ec7e0e54beac5759fba7efa06c48081dbd96c7299c29c92a9c619036ce057cec357ad4ad71a165d7f881df120b043b",
  "9f0801335a952bdbac70b6793150738d7ce30bc3a0d520fec6f573de22a822aa5ef762f78648bc8608ca0b2eeccda556",
  "a145e8524bbe8764d4db6b81b4e18d72eae42e8b9e1c834e62e22aba18cce318f9eaa84942671c688c3eeb89ec30b0e8",
  "5d29c3691cd38f6c6ce0da2b2f9d1da82712d9da12a89c99d38a03cae6369ebe6ba7a1ab1060cfa9daf6a19228c7a2dc",
  "6c962286faed81c395bcf3d319011f91893cfec723c2dc7069ad8805980d77e99f75c94671881cc793794521fe5d2ff0",
  "578945d0342d346d72e50b36ffe74a3631e53e111bc010394108457e362d10830ebadcc7ec5ffa4445d5b10b9c522d28",
  "7e9f760db923c6f31fd18db06f6b60a53902beb6b0d80b91b5355d33c461e43bcddc31c08e2380ff9dc75c10909e6acb",
  "5b6bffe6953eef271a69e453072b6e202ae024cd3983fff3a637b7421a60ad92ab3fd19f8ae809e19182a3feebbe94c2",
  "551006e397efd43a619b370ef336a6a594d8a8338cd49860e54845330354c73afd3ba673360d50f78e5f1d702e19946b",
  "eecf817c561e633b30632ca434a28ad56ed46395d765172fedcc0742d8d5c9982845d6ce32b6451b943f4b6f0a55ea36",
  "3df18dce5385b467208bfa325d2f812bd622ef6def87ef97e63116310a896427db9f2c69d7c2631bccc9c65549b3d512",
  "a51fcaeafa6d188b46d11710442f981169304aa4feecc4b40263943966c3dd8ff9b986d30989b4152fa1540c85a76b5e",
  "f977e0490f5abfc77c311b426399bddd6909848bb8175db4142885c839e9cc23c3ca0047317b039883dce4b1a2efe096",
  "d5f13dff5647f5f4ee351dd9e1ba9348ecd39da88acd6ffd9c324897b0ca7563da974b08c2e84504a76dc98b48700b74",
  "2babe4262b2a00949eeef5b04a81327eb606dc347caaf507527d04f8847730a31dd26d6d7be3e0a672c537b51c914133",
  "25a0967ec1366bc0ec43e45e2f89c435adb1a3e54d8702d89599acb442337afcb36f8f64d51a6608cefb3bb1e4f6b8ed",
  "8665867cbb86ea3178f4179cf040fdec9e6df22bdd4f1e3d8df6b2d9096db5aecd8420b42203969bbe9446b585c78870",
  "ef738ca713ddc39dc29505d857c2aac22a0598a714163ae01e2879085e1c262cc5bde3c239b7ce76385d10c5910ed487",
  "41de07c0c12f388f9dc7d87cfa835edce2c58be42f6893f227002329d263285bf78bb209cd69c384dd7566097f2a3d47",
  "a77141c4ac00099cbdd9053e0190b70234aa2eccdb22cb358e9b8b0fef5bef6b7ad6d9b5eb73137244a3790f98869505",
  "70dde35fed128d1cb007f8c6edfa3de70e991955e1748aa500ad4685d1c752b1775565fb9a6d11c483969d5596e3b159",
  "f0ea83ee58b3a4a9ebe7c8c74f102eba17118711573b6ce773b6f31ed223564cbf215992b5a7a30462b70281ae624453",
  "f7adfbec8cf3a014f9585c7decc21bb03a50484339811ea3b44947d23fc16aff8eedb56346915b816e83fc5faad55e7a",
  "917f7d95eabd64eabd1145cc0898c08ff414037775fd416162002c4783b4f95dcb550c3c5493baadaf41eaceb0e7da0d",
  "74b1cbd4398f319a636de05d36eaa40953df4dc0bb86769f7ac4e0fe2c576f55b3c4a15a5583048ded80b0b4d303f55e",
  "420088665bd62edcba51dfbcc55cbc85611529985fde54b655a3476198a8f9421e02d1898db28180b153550ceeb66798"
]);
var enc = new TextEncoder();
var unb64 = (s) => Uint8Array.from(atob(String(s)), (c) => c.charCodeAt(0));
var hex = (u8) => [...new Uint8Array(u8)].map((b) => b.toString(16).padStart(2, "0")).join("");
var same = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);
var PROOFS = ["attestation", "signature", "rekor"];
async function sentinelPcrOfRelease(r, { builders = BUILD_ENCLAVE_PCR0, links = null, verify = verifyAttestation, site = chainFromSite } = {}) {
  const trusted = Array.isArray(links) && links.length ? await trustedBuilders(links, { anchors: builders, verify }) : builders;
  try {
    return await recordPcr(r, "standing-sentinel", trusted, verify);
  } catch (e) {
    if (!site || !/not made by a build enclave this app trusts/.test(String(e && e.message || e))) throw e;
    const all = [...Array.isArray(links) ? links : [], ...await site()];
    if (!all.length) throw e;
    return recordPcr(r, "standing-sentinel", await trustedBuilders(all, { anchors: builders, verify, max: Infinity }), verify);
  }
}
var _siteChain = null;
var CHAIN_URLS = Object.freeze(["https://api.witbitz.chat/v1/trust/build-enclave.jsonl", "/audit/releases/build-enclave.jsonl"]);
function chainFromSite({ fetchFn = typeof fetch === "function" ? fetch : null, urls = CHAIN_URLS } = {}) {
  if (!fetchFn) return Promise.resolve([]);
  const own = fetchFn === globalThis.fetch && urls === CHAIN_URLS;
  if (own && typeof process !== "undefined" && process.env && process.env.NODE_TEST_CONTEXT) return Promise.resolve([]);
  if (!own) return readChain(fetchFn, urls);
  return _siteChain || (_siteChain = readChain(fetchFn, urls).then((l) => {
    if (!l.length) _siteChain = null;
    return l;
  }));
}
function readChain(fetchFn, urls) {
  return (async () => {
    for (const u of urls) {
      try {
        const res = await fetchFn(u, { cache: "no-store" });
        if (!res || res.status !== 200 || /text\/html/.test(res.headers && res.headers.get && res.headers.get("content-type") || "")) continue;
        const l = linksOfLogText(await res.text());
        if (l.length) return l;
      } catch {
      }
    }
    return [];
  })();
}
function linksOfLogText(text) {
  const out = [];
  for (const l of String(text || "").split("\n")) {
    try {
      const r = JSON.parse(l);
      if (r && r.subject === "build-enclave" && r.verdict === "pass") out.push(r);
    } catch {
    }
  }
  return out.reverse();
}
var BUILD_ENCLAVE_DENY = Object.freeze([]);
var LINKS_MAX = 4;
var verified = /* @__PURE__ */ new Map();
async function trustedBuilders(links = [], { anchors = BUILD_ENCLAVE_PCR0, deny = BUILD_ENCLAVE_DENY, verify = verifyAttestation, max = LINKS_MAX } = {}) {
  const denied = new Set((deny || []).map((x) => String(x).toLowerCase()));
  const trusted = new Set((anchors || []).map((x) => String(x).toLowerCase()).filter((x) => !denied.has(x)));
  const cache = verify === verifyAttestation;
  let pending = Array.isArray(links) ? links.slice(0, max) : [];
  for (let grew = true; grew && pending.length; ) {
    grew = false;
    const left = [];
    for (const l of pending) {
      try {
        const sig = l && l.signature && typeof l.signature.sig === "string" ? l.signature.sig : "";
        const known = sig && cache ? verified.get(sig) : null;
        let p;
        if (known && trusted.has(known.builder) && String(l.measurement && l.measurement.pcr0 || "").toLowerCase() === known.pcr0) p = known.pcr0;
        else {
          const got = await recordPcrBy(l, "build-enclave", [...trusted], verify);
          p = got.pcr0;
          if (sig && cache) {
            if (verified.size >= 4096) verified.delete(verified.keys().next().value);
            verified.set(sig, got);
          }
        }
        if (!denied.has(p) && !trusted.has(p)) {
          trusted.add(p);
          grew = true;
        }
      } catch (e) {
        if (/not made by a build enclave this app trusts/.test(String(e && e.message || e))) left.push(l);
      }
    }
    pending = left;
  }
  return [...trusted];
}
async function recordPcr(r, subject, builders, verify) {
  return (await recordPcrBy(r, subject, builders, verify)).pcr0;
}
async function recordPcrBy(r, subject, builders, verify = verifyAttestation) {
  if (!r || typeof r !== "object") throw new Error("no release record came with the attestation");
  if (r.subject !== subject || r.verdict !== "pass") throw new Error(`the record is not a passing ${subject} release`);
  const repro = Array.isArray(r.checks) && r.checks.find((c) => c && c.name === "reproducible-build");
  if (!repro || repro.ok !== true) throw new Error("the record does not say the image was rebuilt from its source");
  const pcr0 = String(r.measurement && r.measurement.pcr0 || "").toLowerCase();
  if (!/^[0-9a-f]{96}$/.test(pcr0) || r.claim && String(r.claim.pcr0 || "").toLowerCase() !== pcr0) throw new Error("the record names no single PCR0");
  if (!r.attestation || !r.attestation.doc || !r.signature || !r.signature.key || !r.signature.sig) throw new Error("the record carries no proof");
  const rest = {};
  for (const [k, v] of Object.entries(r)) if (!PROOFS.includes(k)) rest[k] = v;
  const art = enc.encode(JSON.stringify(rest));
  const doc = await verify(unb64(r.attestation.doc), { atDocTime: true });
  const builder = String(doc.pcrs && doc.pcrs[0] || "").toLowerCase();
  if (!builders.includes(builder)) throw new Error("the record was not made by a build enclave this app trusts");
  const want = enc.encode(JSON.stringify({ role: "build-enclave", verdict: hex(await crypto.subtle.digest("SHA-256", art)) }));
  if (!doc.userData || !same(new Uint8Array(doc.userData), want)) throw new Error("the build enclave's attestation is not for this record");
  const spki = unb64(r.signature.key);
  if (!doc.publicKey || !same(new Uint8Array(doc.publicKey), spki)) throw new Error("the record is not signed by the key the build enclave attested");
  const key = await crypto.subtle.importKey("spki", spki, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
  const ok = await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, key, derSigToRaw(unb64(r.signature.sig), 32), art);
  if (!ok) throw new Error("the record's signature does not verify");
  return { pcr0, builder };
}

// spaces/public/sdk/4.4.0/sealShare.js
var enc2 = new TextEncoder();
var b64 = (u8) => btoa(String.fromCharCode(...new Uint8Array(u8)));
async function sealTo(enclaveKey, nonce, bundle) {
  const eph = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-384" }, true, ["deriveBits"]);
  const shared = await crypto.subtle.deriveBits({ name: "ECDH", public: enclaveKey }, eph.privateKey, 384);
  const hk = await crypto.subtle.importKey("raw", shared, "HKDF", false, ["deriveKey"]);
  const key = await crypto.subtle.deriveKey({ name: "HKDF", hash: "SHA-256", salt: nonce, info: enc2.encode("witbitz-cc share v1") }, hk, { name: "AES-GCM", length: 256 }, false, ["encrypt"]);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: nonce }, key, enc2.encode(JSON.stringify(bundle))));
  const epk = new Uint8Array(await crypto.subtle.exportKey("raw", eph.publicKey));
  return { epk: b64(epk), iv: b64(iv), ct: b64(ct), nonce: b64(nonce) };
}

// spaces/public/sdk/4.4.0/connDisp.js
var enc3 = new TextEncoder();
var dec = new TextDecoder();
var SALT = enc3.encode("witbitz-sentinel-display-v1");
var INFO = enc3.encode("sentinel-display");

// spaces/public/sdk/4.4.0/connections.js
var STANDING_SENTINEL_PCR0 = ["1903ce28fc5a75efe2e57a451d667f1ce8b4b6e11872fb2b81d9e62d8cd994ed80fcfa99807f289af5f281aa4e4cc010"];
var b642 = (u8) => btoa(String.fromCharCode(...new Uint8Array(u8)));
var unb642 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
var ConnectionError = class extends Error {
  constructor(m, code = "") {
    super(m);
    this.code = code;
  }
};
var ACCEPTED_KEY = "space:sentinelAccepted";
var _follow = null;
var acceptedPcrs = () => {
  try {
    const a = JSON.parse(localStorage.getItem(ACCEPTED_KEY) || "[]");
    return Array.isArray(a) ? a.filter((x) => /^[0-9a-f]{96}$/.test(x)) : [];
  } catch {
    return [];
  }
};
var rememberPcr = (p) => {
  try {
    const a = acceptedPcrs();
    if (!a.includes(p)) localStorage.setItem(ACCEPTED_KEY, JSON.stringify([...a, p].slice(-4)));
  } catch {
  }
};
async function publishedSentinelPins(fetchImpl = (u, o) => fetch(u, o), url = "/sentinel-claim.json") {
  try {
    const r = await fetchImpl(url, { cache: "no-store" });
    if (!r.ok) return [];
    const c = await r.json();
    return Array.isArray(c && c.pcr0) ? c.pcr0.filter((x) => /^[0-9a-f]{96}$/.test(x)) : [];
  } catch {
    return [];
  }
}
async function verifyFollowing(verify, docBytes, { nonce, pins, follow, release = null, links = null }) {
  const f = follow || _follow;
  const following = f && pins === STANDING_SENTINEL_PCR0;
  const tryPins = (set) => verify(docBytes, { nonce, maxAgeMs: 12e4, expectedPCRs: { 0: set } });
  const known = following ? [.../* @__PURE__ */ new Set([...pins, ...acceptedPcrs()])] : pins;
  try {
    return await tryPins(pins);
  } catch (first) {
    if (!following || !/PCR0/i.test(String(first && first.message || first))) throw first;
    for (const p of known.filter((x) => !pins.includes(x))) {
      try {
        return await tryPins([p]);
      } catch {
      }
    }
    if (release) {
      let p = null;
      try {
        p = await sentinelPcrOfRelease(release, { links });
      } catch {
        p = null;
      }
      if (p && !known.includes(p)) {
        let doc = null;
        try {
          doc = await tryPins([p]);
        } catch {
          doc = null;
        }
        if (doc) {
          if (f.auto() || await f.ask(p)) {
            rememberPcr(p);
            return doc;
          }
          throw new ConnectionError("you did not accept the new Witbitz Sentinel build, so nothing was sent to it", "declined");
        }
      }
    }
    for (const p of (await publishedSentinelPins(f.fetch || void 0, f.claimUrl || void 0)).filter((x) => !known.includes(x))) {
      let doc = null;
      try {
        doc = await verify(docBytes, { nonce, maxAgeMs: 12e4, expectedPCRs: { 0: [p] } });
      } catch {
        continue;
      }
      if (f.auto() || await f.ask(p)) {
        rememberPcr(p);
        return doc;
      }
      throw new ConnectionError("you did not accept the new Witbitz Sentinel build, so nothing was sent to it", "declined");
    }
    throw first;
  }
}
async function attestStandingSentinel({ post, auth = {}, pins = STANDING_SENTINEL_PCR0, verify = verifyAttestation, follow = null }) {
  if (!Array.isArray(pins) || !pins.length) throw new ConnectionError("the standing Sentinel is not pinned in this build \u2014 nothing can be attached yet", "unpinned");
  const nonce = crypto.getRandomValues(new Uint8Array(32));
  const r = await post({ op: "sentinel", sentinel: { mode: "attest", nonce: b642(nonce) }, ...auth });
  if (!r || r.error || typeof r.doc !== "string") throw new ConnectionError(`the Sentinel could not be reached (${r && r.error || "no attestation"})`, r && r.error || "unreachable");
  let doc;
  try {
    doc = await verifyFollowing(verify, unb642(r.doc), { nonce, pins, follow, release: r.release && typeof r.release === "object" ? r.release : null, links: Array.isArray(r.links) ? r.links : null });
  } catch (e) {
    if (e instanceof ConnectionError) throw e;
    throw new ConnectionError(`the Sentinel is not running the published Witbitz image, so nothing was sent to it (${String(e && e.message || e).split("\n")[0]})`, "attestation");
  }
  let said = null;
  try {
    said = JSON.parse(new TextDecoder().decode(doc.userData || new Uint8Array(0)));
  } catch {
  }
  if (!said || said.role !== "sentinel") throw new ConnectionError("the attestation does not name a Sentinel, so nothing was sent to it", "attestation");
  const key = await crypto.subtle.importKey("spki", doc.publicKey, { name: "ECDH", namedCurve: "P-384" }, false, []);
  return { nonce, key, spki: new Uint8Array(doc.publicKey) };
}
var MCP_CURATED = CATALOG.filter((c) => c.url).map((c) => ({ label: c.name, url: c.url }));

// spaces/public/sdk/4.4.0/sdkRedact.js
var REDACTED = "[REDACTED]";
var INSPECT = /* @__PURE__ */ Symbol.for("nodejs.util.inspect.custom");
function hide(obj, names) {
  for (const n of names) {
    const d = Object.getOwnPropertyDescriptor(obj, n);
    Object.defineProperty(obj, n, { value: d ? d.value : void 0, writable: true, configurable: true, enumerable: false });
  }
  return obj;
}
function redacted(proto, summary) {
  Object.defineProperty(proto, "toJSON", { value: function toJSON() {
    return summary(this);
  }, writable: true, configurable: true });
  Object.defineProperty(proto, INSPECT, {
    value: function inspect(depth, options, nodeInspect) {
      const s = summary(this);
      const name = this && this.constructor && this.constructor.name || "Object";
      return typeof nodeInspect === "function" ? `${name} ${nodeInspect(s, options)}` : { [name]: s };
    },
    writable: true,
    configurable: true
  });
}

// spaces/public/sdk/4.4.0/witbitz-admin.js
var adminError = (code, message) => Object.assign(new Error(message), { code: String(code || "refused") });
var DEFAULT_ENDPOINT = "https://api.witbitz.chat/v1/space";
var ownerRetired = () => adminError("owner_rule_retired", "witbitz: the owner rule (rooms only your app may use) is retired \u2014 a web page cannot prove which app it is (sdk-changes.md, 4.0.0)");
var TenantOwner = class {
  constructor(admin) {
    this._a = admin;
  }
  async register() {
    throw ownerRetired();
  }
  async rotate() {
    throw ownerRetired();
  }
  async room() {
    throw ownerRetired();
  }
};
var WitbitzAdmin = class {
  /** RETIRED in 4.0.0 (the owner rule, above). */
  static async generateOwnerKey() {
    throw ownerRetired();
  }
  /** @param {object} opts { tenant, tenantKey, signingKey?, endpoint?, tenantEndpoint?, fetchImpl?, sentinel? } — `signingKey`: your
   *  tenant's Ed25519 PRIVATE key (a JWK, or its JSON string; WitbitzAdmin.generateSigningKey()), kept on your server. */
  constructor({ tenant = "", tenantKey = "", signingKey = null, endpoint = DEFAULT_ENDPOINT, tenantEndpoint, fetchImpl, sentinel } = {}) {
    this._endpoint = endpoint;
    this._tenant = tenant || "";
    this._tenantKey = tenantKey || "";
    this._signingKey = signingKey ? typeof signingKey === "string" ? JSON.parse(signingKey) : signingKey : null;
    this._tenantEndpointOverride = tenantEndpoint ? String(tenantEndpoint) : "";
    this._fetch = typeof fetchImpl === "function" ? fetchImpl : ((...a) => fetch(...a));
    this.owner = new TenantOwner(this);
    const ownPins = !!(sentinel && Array.isArray(sentinel.pins)), off = !!(sentinel && sentinel.follow === "off");
    this._sentinel = {
      pins: ownPins ? sentinel.pins : STANDING_SENTINEL_PCR0,
      ...sentinel && typeof sentinel.verify === "function" ? { verify: sentinel.verify } : {},
      follow: ownPins || off ? null : { auto: () => true, ask: async () => false, claimUrl: String(sentinel && sentinel.claimUrl || "https://witbitz-spaces.pages.dev/sentinel-claim.json"), fetch: (u, o) => this._fetch(u, o) }
    };
    this.origins = new TenantOrigins(this);
    this.app = new TenantApp(this);
    this.hosts = new DeclaredHosts(this);
    this.providers = new Providers(this);
    this.rooms = new TenantRooms(this);
    this.signing = new TenantSigning(this);
    this.customers = new TenantCustomers(this);
    this.billing = new TenantBilling(this);
    this.keys = new TenantKeys(this);
    hide(this, ["_tenantKey", "_signingKey", "_fetch"]);
  }
  /** The BUILDER's transport: the same endpoint with a tenant SECRET key, which the /v1 authorizer resolves to a
   *  tenant before this reaches any handler. Server-side only. */
  /**
   * ⛔ A BUILDER CALL MUST NOT GO TO THE SPACE ENDPOINT (2026-09-27, found by a builder whose key was fine all along).
   * `/v1/space` is deliberately KEYLESS — a Space authenticates by its own key-commitment — so no authorizer runs there
   * and an `authorization: Bearer wsk_…` header is never examined. Every builder op therefore answered 403
   * `tenant_required`, identically for a real key and a forged one, and the whole builder half was unreachable in
   * production while the refusal read like a bad secret. Builder ops belong on the AUTHENTICATED twin, where the
   * gateway checks the key and hands the handler a tenant it cannot have been told.
   */
  _tenantEndpoint() {
    if (this._tenantEndpointOverride) return this._tenantEndpointOverride;
    return this._endpoint.replace(/\/space(?=$|[?#])/, "/tenant-space");
  }
  /** A /v1/tenant REST route beside the tenant twin (`/v1/tenant-space` → `/v1/tenant` + path), called with the tenant
   *  key. Unlike the twin these answer the /v1 envelope — `{ data }` or `{ error: { code, message } }` — and a refusal
   *  is thrown with the server's own words, since they name exactly what was wrong. */
  async _tenantRest(method, path, body, { envelope = true, root = "/tenant", text = false } = {}) {
    const key = this._tenantKey;
    if (!key) throw adminError("no_tenant_key", "witbitz: this needs a tenant secret key (wsk_), or a restricted key (wrk_) with the capability \u2014 new WitbitzAdmin({ tenant, tenantKey }) ON YOUR SERVER, never in a page");
    const url = this._tenantEndpoint().replace(/\/tenant-space(?=$|[?#])/, root + path);
    const r = await this._fetch(url, { method, headers: { ...body ? { "content-type": "application/json" } : {}, authorization: `Bearer ${key}` }, ...body ? { body: JSON.stringify(body) } : {} });
    if (text && r && r.ok !== false) return r.text();
    let j = null;
    try {
      j = await r.json();
    } catch {
      j = null;
    }
    if (r && r.ok === false) {
      const err = j && j.error ? typeof j.error === "object" ? j.error : { code: String(j.error), message: j.message || String(j.error) } : null;
      const auth = !err && (r.status === 401 || r.status === 403);
      const e = new Error(auth ? `witbitz: the tenant key was not accepted at ${url} (HTTP ${r.status}) \u2014 check the key with verifyTenantKey()` : `witbitz: ${url} refused: ${err && err.message || "HTTP " + r.status}`);
      e.code = auth ? "tenant_key_rejected" : err && err.code || "http_" + r.status;
      e.status = r.status;
      throw e;
    }
    if (!j || typeof j !== "object" || envelope && !j.data) {
      const e = new Error(`witbitz: ${url} did not answer with data`);
      e.code = "bad_response";
      throw e;
    }
    return envelope ? j.data : j;
  }
  _tenantPost() {
    const key = this._tenantKey;
    if (!key) throw adminError("no_tenant_key", "witbitz: this needs a tenant secret key \u2014 new WitbitzAdmin({ tenant, tenantKey }) ON YOUR SERVER, never in a page");
    const url = this._tenantEndpoint();
    return async (body) => {
      if (this._signingKey && body && body.op === "sentinel" && body.sentinel && body.sentinel.mode !== "whoami") body = await this._signed(body);
      const r = await this._fetch(url, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${key}` }, body: JSON.stringify(body) });
      if (r && r.ok === false) {
        const auth = r.status === 401 || r.status === 403;
        let reason = null;
        if (!auth) {
          try {
            const b = await r.json();
            reason = b && (b.error || b.message) ? b : null;
          } catch {
            reason = null;
          }
        }
        const said = reason && reason.error ? `: ${reason.error}${reason.reason ? " \u2014 " + reason.reason : ""}` : "";
        const timedOut = (r.status === 503 || r.status === 504) && !(reason && reason.error);
        const e = new Error(auth ? `witbitz: the tenant key was not accepted at ${url} (HTTP ${r.status}). The enclave was never reached \u2014 check the key with verifyTenantKey()` : timedOut ? `witbitz: ${url} answered HTTP ${r.status} \u2014 the request ran past the gateway's 30 s limit; it may still have finished. Call again: the operation is safe to repeat` : `witbitz: ${url} answered HTTP ${r.status}${said}`);
        e.code = auth ? "tenant_key_rejected" : timedOut ? "gateway_timeout" : reason && reason.error || "http_" + r.status;
        e.status = r.status;
        if (reason) e.body = reason;
        throw e;
      }
      try {
        return await r.json();
      } catch {
        const e = new Error(`witbitz: ${url} did not answer with JSON`);
        e.code = "bad_response";
        throw e;
      }
    };
  }
  /** Is this tenant key good, and whose is it? → `{ ok: true, tenant }` or `{ ok: false, reason }`.
   *
   *  It exists because there was no way to ask (a builder, 2026-09-27: *"I am not 100% sure the secret I saved was the
   *  right one, but currently I can't even check that"*). Reaching the answer at all is the proof: the gateway refuses a
   *  key it does not recognise before this ever runs. Costs nothing — no enclave round trip, and it works on a
   *  deployment with no standing Sentinel, which is exactly when someone is setting one up. */
  /** The tenant's own signature over one request: Ed25519 over "witbitz-tenant-op v1\n<tenant>\n<ts>\n<nonce>\n<hex sha256(req)>", where
   *  <tenant> is the name the gateway knows this tenant key by (asked once, `whoami`) and <req> the exact JSON sent. */
  async _signed(body) {
    if (!this._signedTenant) {
      const v = await this.verifyTenantKey();
      if (!v.ok) throw adminError("tenant_key_rejected", "witbitz: could not sign \u2014 " + v.reason);
      this._signedTenant = v.tenant;
    }
    const req = JSON.stringify(body.sentinel), ts = String(Date.now());
    const nonce = b64u(globalThis.crypto.getRandomValues(new Uint8Array(16)));
    const h = new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(req)));
    const msg = `witbitz-tenant-op v1
${this._signedTenant}
${ts}
${nonce}
${Array.from(h, (b) => b.toString(16).padStart(2, "0")).join("")}`;
    const key = await globalThis.crypto.subtle.importKey("jwk", { kty: "OKP", crv: "Ed25519", d: this._signingKey.d, x: this._signingKey.x }, { name: "Ed25519" }, false, ["sign"]);
    const sig = new Uint8Array(await globalThis.crypto.subtle.sign({ name: "Ed25519" }, key, new TextEncoder().encode(msg)));
    return { ...body, sentinel: JSON.parse(req), tsig: { ts, nonce, sig: b64u(sig), req } };
  }
  /** A new tenant signing key: `{ privateKey }` (a JWK — keep it on your server, as you keep the tenant key) and `{ publicKey }`
   *  (raw Ed25519, base64url — what `admin.signing.register()` files). */
  static async generateSigningKey() {
    const k = await globalThis.crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
    const jwk = await globalThis.crypto.subtle.exportKey("jwk", k.privateKey);
    return { privateKey: { kty: "OKP", crv: "Ed25519", d: jwk.d, x: jwk.x }, publicKey: jwk.x };
  }
  async verifyTenantKey() {
    const post = this._tenantPost();
    let r;
    try {
      r = await post({ op: "sentinel", sentinel: { mode: "whoami" } });
    } catch (e) {
      return { ok: false, reason: String(e && e.message || e), code: e && e.code || "" };
    }
    if (r && r.ok && r.tenant) return { ok: true, tenant: String(r.tenant) };
    const reason = r && (r.reason || r.message || r.error) || "no answer";
    return { ok: false, reason: String(reason) };
  }
};
redacted(WitbitzAdmin.prototype, (a) => ({ tenant: a._tenant || null, tenantKey: a._tenantKey ? REDACTED : null, ...a._signingKey ? { signingKey: REDACTED } : {} }));
var b64u = (u8) => btoa(String.fromCharCode(...u8)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
var TenantSigning = class {
  constructor(admin) {
    this._a = admin;
    hide(this, ["_a"]);
  }
  /** Which signing key the Sentinel holds for this tenant: `{ registered, key }`. Watch it — removing the record from the store is
   *  the one change someone with access to the Sentinel's storage could make (it cannot be forged, only deleted). */
  async status() {
    const r = await this._a._tenantPost()({ op: "sentinel", sentinel: { mode: "tenantkeyget" } });
    if (!r || r.error) throw adminError("refused", "witbitz: the signing key could not be read" + (r && r.error ? ": " + r.error : ""));
    return { registered: !!r.key, key: r.key || null, origins: Array.isArray(r.origins) ? r.origins : null };
  }
  /** File your SIGNED list of origins with the Sentinel (default: the list you declared — origins.list()). Once filed, a page
   *  that names your tenant there must be one of these; Witbitz's own app may name you only if you list one of its origins.
   *  Needs a registered signing key. Replaces the list held. */
  async publishOrigins(origins) {
    const list = Array.isArray(origins) ? origins.map(String) : await this._a.origins.list();
    if (!this._a._signingKey) throw adminError("no_signing_key", "witbitz: publishOrigins signs the list \u2014 new WitbitzAdmin({ \u2026, signingKey })");
    const r = await this._a._tenantPost()({ op: "sentinel", sentinel: { mode: "tenantorigins", origins: list } });
    if (!r || !r.ok) throw adminError(r && r.error && String(r.error).split(":")[0] || "refused", "witbitz: the origin list was not filed" + (r && r.error ? ": " + r.error : ""));
    return { ok: true, origins: r.origins || list };
  }
  /** File the public half of `publicKey` (default: this client's own signing key). Signed by this client's key when it has one. */
  async register(publicKey) {
    const key = String(publicKey || this._a._signingKey && this._a._signingKey.x || "");
    if (!/^[A-Za-z0-9_-]{43}$/.test(key)) throw adminError("invalid_argument", "witbitz: signing.register needs a raw Ed25519 public key (base64url) \u2014 or a client made with { signingKey }");
    const r = await this._a._tenantPost()({ op: "sentinel", sentinel: { mode: "tenantkey", key } });
    if (!r || !r.ok) throw adminError(r && r.error && String(r.error).split(":")[0] || "refused", "witbitz: the signing key was not registered" + (r && r.error ? ": " + r.error : ""));
    return { ok: true, key };
  }
};
var Providers = class {
  constructor(wb) {
    this._wb = wb;
  }
  /** Attach your OAuth app once. The client secret is sealed to the attested enclave and is gone from your process
   *  when this returns. `kind` is one the enclave knows ('google'); the consent URL and every host come from there,
   *  not from you, so no provider can point your users at an unmeasured screen. → { id, kind } */
  async attach({ kind = "google", clientId, clientSecret, redirectUri, scopes, label, tenant } = {}) {
    const wb = this._wb;
    const t = String(tenant || wb._tenant || "");
    if (!t) throw adminError("invalid_argument", "witbitz: which tenant? pass new WitbitzAdmin({ tenant, tenantKey }) \u2014 the key proves it, the id names it");
    if (!clientId || !clientSecret) throw adminError("invalid_argument", "witbitz: a provider needs your OAuth clientId and clientSecret");
    if (!/^https:\/\//.test(String(redirectUri || ""))) throw adminError("invalid_argument", "witbitz: redirectUri must be the https callback you registered with the provider");
    if (!Array.isArray(scopes) || !scopes.length) throw adminError("invalid_argument", "witbitz: name at least one scope your users will be asked for");
    const post = wb._tenantPost();
    const { nonce, key } = await attestStandingSentinel({ post, auth: {}, pins: wb._sentinel.pins, verify: wb._sentinel.verify, follow: wb._sentinel.follow });
    const id = "prov_" + randomId(12);
    const sealed = await sealTo(key, nonce, { id, tenant: t, kind, clientId, clientSecret: String(clientSecret), redirectUri, scopes: scopes.map(String), label: String(label || "") });
    const r = await post({ op: "sentinel", sentinel: { mode: "provgrant", sealed } });
    if (!r || r.error || !r.ok) throw adminError(r && r.error || "refused", `witbitz: the provider was refused (${r && (r.error || r.reason) || "no answer"})`);
    return { id, kind, tenant: t };
  }
  /** A REGISTERED MCP CLIENT: for an MCP server whose sign-in does not let apps register themselves (GitHub, Asana, Box…),
   *  the OAuth app you registered with that sign-in's `issuer` (as its metadata names it, e.g. https://github.com/login/oauth),
   *  and the exact https callback addresses you registered (your page's `/mcp-callback`). Today only the Spaces app signs
   *  in to MCP servers, with the apps filed under its own tenant; one filed under yours is kept for when the SDK does
   *  (connections.md). The secret (if the issuer gave one) is sealed to the attested enclave. `scopes`: the scopes your app was
   *  approved for (a string or an array) — a sign-in with it asks for exactly those, not the server's whole list (Google's
   *  Calendar server lists twelve). → { id, kind: 'mcp' } */
  async attachMcp({ issuer, clientId, clientSecret = "", redirectUris, label, tenant, webhookSecret = "", scopes = "" } = {}) {
    const wb = this._wb;
    const t = String(tenant || wb._tenant || "");
    if (!t) throw adminError("invalid_argument", "witbitz: which tenant? pass new WitbitzAdmin({ tenant, tenantKey }) \u2014 the key proves it, the id names it");
    if (!/^https:\/\//.test(String(issuer || ""))) throw adminError("invalid_argument", "witbitz: issuer must be the https sign-in issuer, like https://github.com/login/oauth");
    if (!clientId) throw adminError("invalid_argument", "witbitz: a registered MCP client needs the clientId the issuer gave you");
    if (!Array.isArray(redirectUris) || !redirectUris.length || !redirectUris.every((u) => /^https:\/\//.test(String(u)))) throw adminError("invalid_argument", "witbitz: redirectUris \u2014 the https callback addresses you registered with the issuer");
    const scopeList = (Array.isArray(scopes) ? scopes.map(String) : String(scopes || "").split(/\s+/)).filter(Boolean);
    if (scopeList.length > 30 || !scopeList.every((x) => /^[\x21\x23-\x5b\x5d-\x7e]{1,200}$/.test(x))) throw adminError("invalid_argument", "witbitz: scopes \u2014 the scope names your app was approved for");
    if (webhookSecret && String(webhookSecret).length < 8) throw adminError("invalid_argument", "witbitz: webhookSecret \u2014 the secret the service signs its notices with (Zoom: the app's Secret Token)");
    const post = wb._tenantPost();
    const { nonce, key } = await attestStandingSentinel({ post, auth: {}, pins: wb._sentinel.pins, verify: wb._sentinel.verify, follow: wb._sentinel.follow });
    const id = "prov_" + randomId(12);
    const sealed = await sealTo(key, nonce, { id, tenant: t, kind: "mcp", issuer: String(issuer), clientId: String(clientId), clientSecret: String(clientSecret || ""), redirectUris: redirectUris.map(String), label: String(label || ""), ...webhookSecret ? { webhookSecret: String(webhookSecret) } : {}, ...scopeList.length ? { scopes: scopeList.join(" ") } : {} });
    const r = await post({ op: "sentinel", sentinel: { mode: "provgrant", sealed } });
    if (!r || r.error || !r.ok) throw adminError(r && r.error || "refused", `witbitz: the MCP client was refused (${r && (r.error || r.reason) || "no answer"})`);
    return { id, kind: "mcp", tenant: t };
  }
  /** Your tenant's providers — never a client secret. */
  async list() {
    const r = await this._wb._tenantPost()({ op: "sentinel", sentinel: { mode: "provlist" } });
    if (!r || r.error) throw adminError(r && r.error || "refused", `witbitz: could not list providers (${r && r.error || "no answer"})`);
    return Array.isArray(r.providers) ? r.providers : [];
  }
  /** Remove an OAuth app. Every connection your users made under it dies at once. → { revoked, connections } */
  async revoke(id) {
    const r = await this._wb._tenantPost()({ op: "sentinel", sentinel: { mode: "provrevoke", id: String(id || "") } });
    if (!r || r.error) throw adminError(r && r.error || "refused", `witbitz: could not revoke (${r && r.error || "no answer"})`);
    return { revoked: Number(r.revoked) || 0, connections: Number(r.connections) || 0 };
  }
};
var randomId = (n) => btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(n)))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
var TenantRooms = class {
  constructor(wb) {
    this._wb = wb;
  }
  /** Delete ONE room. Afterwards it answers 410 to everyone, at once, whichever retention you choose:
   *    retain: 'none'     (default) every stored version of everything is deleted now — sealed messages, files, the
   *                       confidential tier's copies. Irreversible.
   *    retain: 'backups'  the current copies are deleted now; old versions expire within 35 days (recoverable only by
   *                       Witbitz operators, by hand, until then).
   *    retain: 'grace'    nothing is deleted yet; `rooms.restore(room)` undoes it for `graceDays` (1–90, default 30),
   *                       then it is purged as `after` says ('none' default, or 'backups').
   *  Only for a room no one else uses — a shared room belongs to its other members too, and the server cannot tell
   *  (membership is sealed), so that is yours to decide.
   *  → none/backups: { deleted:true, room, retain, versions, bytes, turnWasRunning, backupsUntil? }
   *  → grace:        { deleted:false, held:true, room, purgeAt, after }
   *  When `turnWasRunning`, a reply being written may land a moment later: call delete again after a few minutes.
   *  Throws if anything could not be removed (code 'partial') — never a half-done delete reported as done. */
  async delete(room, { retain, graceDays, after } = {}) {
    if (typeof room !== "string" || !/^(?:sp|tmp)-[0-9a-z-]{1,48}$/.test(room)) throw adminError("invalid_argument", 'witbitz: rooms.delete takes a room id, e.g. "sp-\u2026"');
    const body = { confirm: room, ...retain ? { retain } : {}, ...graceDays !== void 0 ? { graceDays } : {}, ...after ? { after } : {} };
    const r = await this._wb._tenantRest("DELETE", "/rooms/" + encodeURIComponent(room), body, { envelope: false });
    if (r.held) return { deleted: false, held: true, room: r.room, purgeAt: Number(r.purgeAt) || 0, after: r.after || "none" };
    if (!r.deleted) {
      const e = new Error(`witbitz: room ${room} was only partly deleted \u2014 call delete again`);
      e.code = "partial";
      e.result = r;
      throw e;
    }
    return { deleted: true, room: r.room, retain: r.retain || "none", versions: Number(r.versions) || 0, bytes: Number(r.bytes) || 0, turnWasRunning: !!r.turnWasRunning, ...r.backupsUntil ? { backupsUntil: Number(r.backupsUntil) } : {} };
  }
  /** Your rooms, a page at a time: `{ rooms: [{ room, createdAt, lastUsedAt, kind, split, gated, held }], next }`.
   *  `createdAt` / `lastUsedAt` are ISO times or null (`lastUsedAt` is when a member last opened, wrote or prompted in it;
   *  recorded since 2026-10-07). `held` is `{ purgeAt }` for a room pending deletion. Pass `next` back as `cursor`. */
  async list({ cursor, limit } = {}) {
    const q = new URLSearchParams({ list: "1", ...cursor ? { cursor } : {}, ...limit ? { limit: String(limit) } : {} });
    const r = await this._wb._tenantRest("GET", "?" + q.toString(), null, { envelope: false, root: "/tenant/rooms" });
    return { rooms: Array.isArray(r.rooms) ? r.rooms : [], next: r.next || null };
  }
  /** THE IDLE RULE: rooms no member used for `days` (30–3650) are held for 30 days — gone at once, restorable with
   *  `rooms.restore(room)` — then deleted, by a daily run. `null` turns it off. A room with no recorded use counts from
   *  2026-10-07. At most 100 of your rooms are held per day. → { idleRoomDays } */
  async idleDeletion(days) {
    if (days !== null && !(Number.isInteger(days) && days >= 30 && days <= 3650)) throw adminError("invalid_argument", "witbitz: rooms.idleDeletion(days) \u2014 a whole number of days from 30 to 3650, or null to turn it off");
    const d = await this._wb._tenantRest("PUT", "/webhooks", { idleRoomDays: days });
    return { idleRoomDays: d && d.tenant ? d.tenant.idle_room_days ?? null : days };
  }
  /** Undo a `retain: 'grace'` delete before its window ends. → { restored:true, room }. A room deleted with 'none' or
   *  'backups', or whose window has ended, cannot come back (code 'purged' / 'grace_ended'). */
  async restore(room) {
    if (typeof room !== "string" || !/^(?:sp|tmp)-[0-9a-z-]{1,48}$/.test(room)) throw adminError("invalid_argument", 'witbitz: rooms.restore takes a room id, e.g. "sp-\u2026"');
    const r = await this._wb._tenantRest("POST", "/rooms/" + encodeURIComponent(room) + "/restore", {}, { envelope: false });
    return { restored: !!r.restored, room: r.room };
  }
};
var USER_ID = /^u_[a-z0-9]{24}$/;
var userIdOf = (id, what) => {
  if (typeof id !== "string" || !USER_ID.test(id)) throw adminError("invalid_argument", `witbitz: ${what} takes a user id, e.g. "u_\u2026" (from users.create)`);
  return id;
};
var TenantKeys = class {
  constructor(wb) {
    this._wb = wb;
  }
  /** → [{ keyId, type, label, createdAt, revoked, display, scopes?, expiresAt?, maxCustomerCapUsd? }] — never a key */
  async list() {
    return await this._wb._tenantRest("GET", "/keys");
  }
  /** → { key, keyId, type, scopes?, maxCustomerCapUsd?, expiresAt? } — `key` is shown ONCE: store it now.
   *  @param {object} opts { type: 'restricted' | 'secret' | 'publishable', label?, scopes?, expiresAt?, maxCustomerCapUsd? } */
  async create({ type = "restricted", label, scopes, expiresAt, maxCustomerCapUsd } = {}) {
    const d = await this._wb._tenantRest("POST", "/keys", { type, ...label ? { label } : {}, ...scopes ? { scopes } : {}, ...expiresAt != null ? { expiresAt } : {}, ...maxCustomerCapUsd != null ? { maxCustomerCapUsd } : {} });
    return { key: d.key, keyId: d.key_id, type: d.type, ...d.type === "restricted" ? { scopes: d.scopes || [], maxCustomerCapUsd: d.max_customer_cap_usd ?? null, expiresAt: d.expires_at ?? null } : {} };
  }
  /** Revoke a key — refused from then on. → { revoked: true, keyId } */
  async revoke(keyId) {
    if (!/^k_[0-9A-Za-z]{1,40}$/.test(String(keyId || ""))) throw adminError("invalid_argument", "witbitz: keys.revoke(keyId) \u2014 the keyId from keys.list()");
    await this._wb._tenantRest("DELETE", "/keys/" + encodeURIComponent(keyId), null, { envelope: false, text: true });
    return { revoked: true, keyId };
  }
};
var TenantCustomers = class {
  constructor(wb) {
    this._wb = wb;
  }
  /** `userRef` — YOUR label for the user (1–120 chars; shown to you in billing, never to the provider). `capMonthlyUsd`
   *  — a hard monthly stop (default 25). → { userId, userRef, capMonthlyUsd, createdAt, revoked } */
  async create({ userRef, capMonthlyUsd } = {}) {
    const d = await this._wb._tenantRest("POST", "/users", { userRef, ...capMonthlyUsd !== void 0 ? { capMonthlyUsd } : {} });
    return d.user;
  }
  /** Every user you created, oldest first — nothing secret. */
  async list() {
    return await this._wb._tenantRest("GET", "/users");
  }
  /** Change a user's monthly cap — a plan upgrade or a cancellation. The provider's limit moves first; the user, their key
   *  and their history stay the same. A revoked user cannot be changed. → the user, as `create` returns it. */
  async update(userId, { capMonthlyUsd } = {}) {
    const d = await this._wb._tenantRest("PATCH", "/users/" + userIdOf(userId, "users.update"), { capMonthlyUsd });
    return d.user;
  }
  /** Revoke: the user's provider key is deleted and their tokens stop working. Spend up to now is still billed. */
  async revoke(userId) {
    await this._wb._tenantRest("DELETE", "/users/" + userIdOf(userId, "users.revoke"), null, { envelope: false, text: true });
    return { revoked: true, userId };
  }
  /** ERASE A USER WHO IS GONE (https://witbitz.chat/docs/sdk-builder.md#user-erasure): the Spaces this person created in YOUR app that nobody else used are
   *  deleted — every message, file and stored version. Shared Spaces stay (what they wrote is part of the others'
   *  conversation); Spaces they only joined are not theirs to delete. Works from the list the person's own devices filed,
   *  sealed, with Witbitz's attested enclave for your app; you never see it. Run it again after a partial result
   *  (`failed` > 0 or `incomplete`) — nothing is lost. Pair it with `revoke(userId)` for their billing.
   *  → { filed, rooms, deleted, shared, notTheirs, failed, cleared } */
  async erase({ email } = {}) {
    if (typeof email !== "string" || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) throw adminError("invalid_argument", "witbitz: users.erase takes { email } \u2014 the address the person signed in to your app with");
    const r = await this._wb._tenantPost()({ op: "sentinel", sentinel: { mode: "eraseuser", email: email.trim() } });
    if (!r || r.error || r.ok === false) throw adminError(r && r.error || "refused", `witbitz: the erase was refused (${r && (r.error || r.reason) || "no answer"})`);
    return r;
  }
  /** A token for this user's page, valid `ttlSec` (60–3600, default 900). → { token, expiresAt } (unix seconds).
   *  Mint it when the user signs in and again before `expiresAt`; never store it server-side longer than that. */
  async token(userId, { ttlSec } = {}) {
    return await this._wb._tenantRest("POST", "/users/" + userIdOf(userId, "users.token") + "/token", ttlSec !== void 0 ? { ttlSec } : {});
  }
};
var TenantBilling = class {
  constructor(wb) {
    this._wb = wb;
  }
  /** → { tenant, rate, month, storage, days, users, userDays, at } — amounts in microdollars (1e-6 USD). */
  async get() {
    return await this._wb._tenantRest("GET", "", null, { root: "/billing", envelope: false });
  }
  /** REQUIRE A USER TOKEN on every op that spends (a turn, a title, an approval, an import) in your rooms. With it on, such
   *  an op that arrives WITHOUT a user token is refused (`user_token_required`) instead of billed to you — so your
   *  per-user caps cannot be bypassed by a page that simply sends none. Reads never need one. Takes effect within about a
   *  minute. → { requireUserToken } as stored. */
  async requireUserToken(on = true) {
    if (typeof on !== "boolean") throw adminError("invalid_argument", "witbitz: billing.requireUserToken takes true or false");
    const d = await this._wb._tenantRest("PUT", "/webhooks", { requireUserToken: on });
    return { requireUserToken: !!(d && d.tenant && d.tenant.require_user_token) };
  }
  /** LIMIT VISITORS (docs/visitor-limits.md): how many questions a day (UTC) people who are NOT signed in — no user token —
   *  may ask in your rooms: at most `perNetwork` from one network, at most `total` from all of them. Over either, the
   *  question is refused before anything is spent (`429 visitor_limit`, with `scope` and a sentence to show). `null` turns
   *  it off (every question bills to you, as without it). A question with a user token is its user's, under their own cap.
   *  Takes effect within about a minute. → { visitorLimit } as stored. */
  async visitorLimit(limit) {
    const ok = limit === null || limit && typeof limit === "object" && !Array.isArray(limit) && Object.keys(limit).every((k) => k === "perNetwork" || k === "total") && Number.isInteger(limit.perNetwork) && Number.isInteger(limit.total) && limit.perNetwork >= 1 && limit.perNetwork <= limit.total && limit.total <= 1e7;
    if (!ok) throw adminError("invalid_argument", "witbitz: billing.visitorLimit takes { perNetwork, total } \u2014 whole numbers of questions a day, 1 \u2264 perNetwork \u2264 total \u2264 10000000 \u2014 or null to turn it off");
    const d = await this._wb._tenantRest("PUT", "/webhooks", { visitorLimit: limit === null ? null : { perNetwork: limit.perNetwork, total: limit.total } });
    const vl = d && d.tenant ? d.tenant.visitor_limit : null;
    return { visitorLimit: vl && typeof vl === "object" ? { perNetwork: vl.perNetwork, total: vl.total } : null };
  }
  /** The same as CSV text: one line per day, or with `{ byUser: true }` one line per user per day. */
  async csv({ byUser = false } = {}) {
    return await this._wb._tenantRest("GET", "?format=csv" + (byUser ? "&by=user" : ""), null, { root: "/billing", text: true });
  }
  /** YOUR PREPAID BALANCE (docs/tenant-prepaid.md), or null when your app is not on prepaid billing.
   *  → { balanceMicros, paused: null | 'out_of_credit', lowWarned, earlyAccess, canBuy, packs: [{ pack, dollars, credit }], history: [{ at, kind, micros, orderId? }] }
   *  (`canBuy`: buying credit is open to your app now — while it is in testing, only to the apps in the test).
   *  While `paused`, every op that spends in your rooms is refused (`402 tenant_out_of_credit`) until you add credit. */
  async balance() {
    const v = await this.get();
    return v && v.prepaid || null;
  }
  /** ADD CREDIT: a payment page for one pack — 'pack25' | 'pack100' | 'pack500' — bound to your app. Open its `url` in a browser
   *  (Lemon Squeezy takes the payment and the tax); the credit lands within a minute of paying, and lifts a pause at once.
   *  `redirectUrl` (https): where the payer returns. Needs your SECRET key. → { url, pack, dollars, testMode }
   *  Refused with `payments_not_open` (buying is not open yet), `not_prepaid` (your app is not on prepaid billing), `not_a_tester`
   *  (buying is in testing, not open to your app), `checkout_unavailable` (the payment page could not be made — try again). */
  async topUp(pack, { redirectUrl } = {}) {
    if (!["pack25", "pack100", "pack500"].includes(pack)) throw adminError("invalid_argument", "witbitz: billing.topUp takes 'pack25', 'pack100' or 'pack500'");
    if (redirectUrl != null && !/^https:\/\/\S{1,300}$/.test(String(redirectUrl))) throw adminError("invalid_argument", "witbitz: billing.topUp redirectUrl must be an https address");
    return await this._wb._tenantRest("POST", "/billing/checkout", { pack, ...redirectUrl ? { redirectUrl } : {} });
  }
};
var TenantApp = class {
  constructor(wb) {
    this._wb = wb;
  }
  /** → { name } as stored. Refused with the reason when the name breaks the rule. */
  async rename(name) {
    if (typeof name !== "string" || !name.trim()) throw adminError("invalid_argument", "witbitz: app.rename takes your app's name, e.g. 'Keepwarden'");
    const d = await this._wb._tenantRest("PUT", "/webhooks", { name });
    return { name: d && d.tenant && d.tenant.name || "" };
  }
  /** The name your app is registered with now. */
  async name() {
    const d = await this._wb._tenantRest("GET", "");
    return d && typeof d.name === "string" ? d.name : "";
  }
};
var TenantOrigins = class {
  constructor(wb) {
    this._wb = wb;
  }
  /** Declare the whole list. Declaring REPLACES what you had — keep the origins you still use.
   *  → { origins, unproven } — origins as stored (lower-cased, trailing slash removed, de-duplicated); unproven = the ones
   *  whose host does not yet say it is yours, each with how to prove it ({ origin, how }). An unproven origin works; only
   *  a proven one puts your app's name in a sign-in mail. Declare again once the file or record is in place. */
  async declare(origins) {
    if (!Array.isArray(origins)) throw adminError("invalid_argument", 'witbitz: origins.declare takes an array, e.g. ["https://app.example.com"]');
    const d = await this._wb._tenantRest("PUT", "/webhooks", { origins: origins.map(String) });
    const out = { origins: Array.isArray(d.tenant && d.tenant.origins) ? d.tenant.origins : [], unproven: Array.isArray(d.origins_unproven) ? d.origins_unproven : [] };
    if (this._wb._signingKey) out.signed = (await this._wb.signing.publishOrigins(out.origins)).origins;
    return out;
  }
  /** The origins this tenant declares now. */
  async list() {
    const d = await this._wb._tenantRest("GET", "");
    return Array.isArray(d.origins) ? d.origins : [];
  }
};
var DeclaredHosts = class {
  constructor(wb) {
    this._wb = wb;
  }
  /** Declare the whole list. Declaring REPLACES what you had, so removing a host is declaring without it.
   *  → { hosts } as the enclave normalised them (lower-cased, scheme and path stripped, de-duplicated). */
  async declare(hosts) {
    if (!Array.isArray(hosts)) throw adminError("invalid_argument", 'witbitz: declare takes an array of bare domains, e.g. ["api.todoist.com"]');
    const r = await this._wb._tenantPost()({ op: "sentinel", sentinel: { mode: "hostdeclare", hosts: hosts.map(String) } });
    if (!r || r.error || !r.ok) throw adminError(r && r.error || "refused", `witbitz: the hosts were refused (${r && (r.error || r.reason) || "no answer"})`);
    return { hosts: Array.isArray(r.hosts) ? r.hosts : [] };
  }
  /** What this tenant currently vouches for. */
  async list() {
    const r = await this._wb._tenantPost()({ op: "sentinel", sentinel: { mode: "hostlist" } });
    if (!r || r.error) throw adminError(r && r.error || "refused", `witbitz: could not list hosts (${r && r.error || "no answer"})`);
    return Array.isArray(r.hosts) ? r.hosts : [];
  }
};
export {
  DEFAULT_ENDPOINT,
  TenantCustomers as TenantUsers,
  WitbitzAdmin
};
