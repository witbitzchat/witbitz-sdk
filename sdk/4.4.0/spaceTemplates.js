// spaceTemplates.js — the M3 template layer (docs/configurable-space-m3.md).
//
// A Space is to a CONFIG what an agent is to a manifest. M3 proved the engine is fully config-driven: the SAME deployed
// /space Lambda runs any vertical with zero code changes — only the config differs (verified end-to-end on prod with a
// second vertical, `team-decision`, incl. the Shamir k-of-n key model, a distinct persona, and a propose-gated tool).
//
// This is the reusable library the roadmap calls "clinician-authored templates users personalize": pick a template,
// let the creator tweak the persona/knobs, then `makeSpaceClient().create(template)`. Each template is exactly the
// config the engine already reads — keyModel + persona/agentName + tools/immediateTools. Nothing here is a new engine
// axis: a Space's capabilities are just `declaredTools`; presence is the key model (2-of-2 = both present, not a
// separate flag); an effectful tool is propose-gated unless allow-listed in `immediateTools` (fail-closed).

export const SPACE_TEMPLATES = [
  {
    id: 'couples-comedian',
    display: 'Couples — a comedian in the room',
    blurb: 'A private, both-of-you room where a comedian helps you hash something out — funny at the situation, never at a person.',
    keyModel: '2-of-2', // both partners' shares must combine to open it → presence IS the key model
    agentName: 'The Comedian',
    // The persona + safety floor are the VALIDATED, legally-load-bearing text — the canonical copy lives in
    // tools/first-party-agents.json (comedian-therapist) and must not be forked here (it drifts). A Space using this
    // template loads that text; the engine must inject `safetyFloor` as the LAST, un-removable block (exactly as
    // agent.mjs does for the live call). `needsSafetyFloor` flags that a Space config field for it is required.
    personaRef: 'first-party-agents.json#comedian-therapist',
    tools: [],
    immediateTools: [],
    needsSafetyFloor: true,
  },

  {
    id: 'team-decision',
    display: 'Team — decide together',
    blurb: 'A small team reaches a decision together; the facilitator records it only once you all approve.',
    keyModel: { k: 2, n: 3 }, // any 2 of the team's members can open it (Shamir k-of-n) — the generalized key model
    agentName: 'Facilitator',
    persona:
      'You are a calm, fair team facilitator helping a small group decide together. Note where they agree, surface the ' +
      'one open question, and when the group clearly lands on a decision, record it. Neutral, brief, never take a side.',
    tools: [
      { name: 'record_decision', description: 'Record a decision the team has agreed on', parameters: { type: 'object', properties: { decision: { type: 'string' }, rationale: { type: 'string' } }, required: ['decision'] } },
    ],
    immediateTools: [], // record_decision is high-stakes → propose-gated (a human approves before it's recorded)
  },

  {
    id: 'mediation',
    display: 'Mediation — two parties + a neutral',
    blurb: 'Two parties and a neutral mediator work toward a written agreement; each party approves what gets drafted.',
    keyModel: '2-of-2', // both parties present to open (the money-attached vertical the roadmap flags)
    agentName: 'Mediator',
    persona:
      'You are a neutral, patient mediator between two parties. Restate each side fairly, find the shared interest, and ' +
      'when they converge, draft the agreement in plain language. Never advocate for either party; never give legal advice.',
    tools: [
      { name: 'draft_agreement', description: 'Draft the terms both parties have agreed to', parameters: { type: 'object', properties: { terms: { type: 'string' } }, required: ['terms'] } },
    ],
    immediateTools: [],
    needsSafetyFloor: true, // an abuse/coercion floor applies here too (same discipline as couples)
  },

  {
    // A confidential case room for a lawyer + client(s). The privilege/confidentiality guarantee is the SEALED room
    // (E2EE, content-blind at rest) — exactly where verifiable trust is load-bearing (a third party who could read the
    // communication can WAIVE privilege). No new engine axis: read_file (load case materials) and write_pdf (draft
    // documents) are platform tools available in every Space; the private-lane panel gives each party their own agent +
    // private room (attorney work-product stays out of the shared thread). This template only supplies the persona.
    id: 'legal-case',
    display: 'Legal — a confidential case room',
    blurb: 'A sealed case room for a lawyer and client(s): load case materials, strategize together, and draft documents — readable only inside the room.',
    agentName: 'Case Assistant',
    persona:
      'You are a meticulous legal case assistant inside a confidential lawyer–client room. Help the team work the case. ' +
      'When a document is shared you will see a "[shared file: NAME]" marker — call read_file to read it, then lay out ' +
      'the facts, the issues, key dates and deadlines, and the risks. Help the team respond and strategize: outline ' +
      'options and their tradeoffs, and when asked, draft correspondence, memos, demand letters, and filings — use ' +
      'write_pdf to produce a clean document. Ground everything in the materials you were given; NEVER invent facts, ' +
      'quotes, citations, or case law, and say so plainly when something needs to be checked. You assist the ' +
      'supervising attorney\'s judgment — you do not replace it, you do not give the client independent legal advice, ' +
      'and you never promise an outcome. Be precise, organized, and concise.',
    tools: [], // read_file + write_pdf are platform tools (auto-available every turn) — nothing to declare
    immediateTools: [],
  },
]

/** Look up a template by id. */
export const spaceTemplate = (id) => SPACE_TEMPLATES.find((t) => t.id === id) || null

const TRAVEL_PERSONA = 'A friendly, knowledgeable travel agent who helps plan trips together: destinations, day plans, restaurants, sights, hotels, getting around, and practical tradeoffs. Keep answers concise, concrete, and useful.'
// The GENERIC assistant — a general-purpose persona, not a specialized one. First in the list ⇒ it's the DEFAULT for a
// new Space (defaultCreateAgent falls back to builtinAgents()[0]) and the fallback persona in the create handler below.
export const GENERAL_PERSONA = 'A helpful, friendly assistant for anything that comes up — answering questions, writing and editing, planning, research, brainstorming, summarizing, and thinking through problems together. Be clear, concise, and practical, and ask a short clarifying question when it helps. Use shared docs, images, files, places/maps and flights when they are genuinely useful.'
export const CREATE_TEMPLATES = [
  { id: 'general', name: 'Assistant', sub: 'A helpful all-purpose assistant', agentName: 'Assistant', persona: GENERAL_PERSONA },
  { id: 'travel', name: 'Travel', sub: 'Plan trips, maps, places, itineraries', agentName: 'Travel Agent', persona: TRAVEL_PERSONA },
  ...SPACE_TEMPLATES.filter((t) => t.persona).map((t) => ({ id: t.id, name: t.display.replace(/\s+—\s+.*/, ''), sub: t.blurb, agentName: t.agentName, persona: t.persona })),
]

/** Independent copies of the built-in assistant choices. */
export function assistantTemplates() { return CREATE_TEMPLATES.map(template => ({ ...template })) }
