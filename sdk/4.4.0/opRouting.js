// Argument position after the room and its key in the room client.
export function routingIndex(op) {
  switch (op) {
    case 'turn': return 2
    case 'decide': return 3
    case 'carry':
    case 'toolRules': return 0
    default: return -1
  }
}
