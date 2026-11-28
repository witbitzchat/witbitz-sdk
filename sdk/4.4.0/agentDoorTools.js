// agentDoorTools.js — the two tools of a Witbitz member's door (agents.witbitz.chat/mcp/<handle>), as the Sentinel lists them
// (infra/cloud-computer/sentinel/mcpDoor.mjs TOOLS, held equal by spaces/test/agentDoorTools.test.mjs). A connection whose key only
// the vault holds cannot be listed by the Sentinel ("opens only with its key now"); its tools are these, known in advance.
export const AGENT_DOOR_HOST = 'agents.witbitz.chat'
export const AGENT_DOOR_TOOLS = Object.freeze([
  {
    name: 'message_member',
    title: 'Message the member',
    description: 'Send a message to the member who gave you this connection — a question, an update, or the result of a task they gave you. It lands in their private assistant, sealed so that only their own devices can read it. This call waits up to about 45 seconds for the answer and returns it when it comes in time — an assistant that answers on its own (one kept always on) usually does. Otherwise it returns a task_id and the state; then call get_reply with that task_id later (a person may take hours). To continue the same conversation, pass the task_id you got before.',
    inputSchema: { type: 'object', properties: { text: { type: 'string', description: 'What to send (plain text, up to 8,000 characters).' }, task_id: { type: 'string', description: 'Optional: an earlier task_id, to continue that conversation.' } }, required: ['text'], additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
  {
    name: 'get_reply',
    title: 'Get the member’s reply',
    description: 'The state of a message you sent with message_member, and the member’s reply once there is one. States: waiting (not read yet), read (the member has it), question (the member asked you something back — answer with message_member and the same task_id), answered, declined, expired.',
    inputSchema: { type: 'object', properties: { task_id: { type: 'string' } }, required: ['task_id'], additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
])

/** The member's agent advertises these two tools even before the Sentinel can read a cached list. */
export async function listGrantTools(host, list) {
  try { return await list() } catch (error) {
    if (host !== AGENT_DOOR_HOST || !/opens only with its key/.test(String(error?.message || error))) throw error
    return { tools: AGENT_DOOR_TOOLS.map(t => ({ ...t, readOnly: t.annotations?.readOnlyHint === true })) }
  }
}
