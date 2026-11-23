// connCatalog.js — the services Connections offers (the owner, 2026-10-14: Grok Bot's connector catalog; "We should just take it?").
// Every address passed the Sentinel's own MCP sign-in steps (infra/cloud-computer/sentinel/mcpAuth.mjs: discover → self-register
// → consent page; tools/conn-catalog/probe.mjs) or answers without a sign-in. Entries marked `src: 'cursor'` take their address,
// description and logo from github.com/cursor/plugins third_party/* (MIT, © 2026 Cursor — see icons/services/NOTICE).
// Five long descriptions are shortened to one line (Trello, Plaud, beehiiv, PostHog, TinyFish). The rest are ours; their marks are in serviceIcons.js (Simple Icons, CC0) or a letter tile.
export const CATALOG = [
  // AN AGENT YOU SEND JOBS TO, not a service you sign in to (the owner, 2026-10-15: "Doesn't grokbot have a connector like
  // other connectors?" → "Yes"). Grok Bot takes MCP servers but offers none; what starts a run from outside is a routine's
  // trigger "When this webhook receives a request": an Endpoint https://grok.com/webhook/automation/<id> and a Signing
  // secret whsec_… — a SIGNED webhook (docs/signed-webhooks.md). Attached through grokRoutine.js; each call is approved.
  { name: "Grok Bot", kind: "webhook", host: "grok.com", desc: "Send a job to one of your Grok Bot routines — you approve each one.", cat: "Agents", png: "/icons/services/grok-bot.png" },
  // CLAUDE CODE (the owner, 2026-10-21: "Let's do Claude code"): the same kind as Grok Bot — a scheduled task's API trigger
  // (a bearer webhook on api.anthropic.com) takes the job, the run reports back through this Space's MCP address. The card and
  // what the room keeps come from jobAgents.js (docs/job-agents.md).
  { name: "Claude Code", kind: "webhook", host: "api.anthropic.com", desc: "Send a job to a Claude Code task in Anthropic's cloud — you approve each one.", cat: "Agents", png: "/icons/services/claude-code.png" },
  // AN AGENT THAT COMES TO YOU (the owner, 2026-10-15: "add a muse ai connector like we did for grokbot"). Meta's Muse takes
  // custom MCP connectors (streamable HTTP, a bearer key) but nothing can start a Muse task from outside — no webhook, no
  // public API (docs/outside-agents.md). So it is ONE way: Muse reaches a Space's private assistant through the Sentinel's
  // MCP door (message_member / get_reply), and a recurring Muse task asks that assistant for work. Set up by connectionsSheet.js openMuse.
  { name: "Muse", kind: "agent", host: "meta.ai", desc: "Let Meta's Muse work with this Space's assistant — it asks for jobs and sends back the results.", cat: "Agents", png: "/icons/services/muse.png" },
  // OpenAI's Dots (the owner, 2026-10-15: "OpenAI new dots bot" → "Do a"): a ChatGPT custom MCP server (name + URL, the key in
  // it). One way for now, as Muse; ChatGPT's MCP Events could push it jobs later (a Sentinel cycle).
  { name: "Dots", kind: "agent", host: "chatgpt.com", desc: "Let your OpenAI dot work with this Space's assistant — it asks for jobs and sends back the results.", cat: "Agents", png: "/icons/services/dots.png" },
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
  { name: "Cloudflare Docs", url: "https://docs.mcp.cloudflare.com/mcp", desc: "Cloudflare’s developer documentation.", cat: "Research" },
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
  { name: "Gmail", kind: "mail", host: "mail.google.com", desc: "Forward the mail you choose into a Space of your own — the assistant reads it when you ask.", cat: "Email" },
]
export const CATEGORY_ORDER = ["Agents", "Engineering", "Productivity", "Documents", "Design", "Meetings", "Scheduling", "Sales", "Marketing", "Customer support", "Data analytics", "Hiring", "Finance", "Travel", "Health", "Research", "Email"]
