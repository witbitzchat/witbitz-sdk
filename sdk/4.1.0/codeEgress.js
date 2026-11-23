// codeEgress.js — what a cloud computer is allowed to reach, as the person chose it (docs/cloud-computer-egress.md).
//
// Pure: no DOM, no storage, no network. The page uses it to validate what it stores and seals; the settings sheet uses
// it to say what a choice means; and `egressHash` lets the page check the policy the ENCLAVE reports having loaded
// against the one it sealed — which is the whole point of the design and the only part that cannot be faked by
// anything between.
//
// ★ THIS MUST REFUSE EXACTLY WHAT THE ENCLAVE'S parsePolicy REFUSES. If the page can store a policy the enclave will
//   reject, the refusal arrives at open time as "your computer would not start", with the person nowhere near the
//   setting that caused it. Refusing here puts the error next to the field.
//
// ★ THERE IS NO 'full'. The owner struck it on 2026-09-17: a mode with unrestricted egress makes "the operator cannot
//   read your workspace" stop meaning anything, because the agent can post the workspace anywhere. It is refused BY
//   NAME rather than merely absent from the list, so a stored doc that names it fails loudly instead of falling back
//   to something permissive.

export const EGRESS_MODES = ['none', 'trusted', 'custom']
export const MAX_CUSTOM_HOSTS = 64

/** What `trusted` reaches, for the page to SHOW. The enclave's copy is the authoritative one — this is a label, and if
 *  the two ever disagree the attested story is right and this is stale.
 *
 *  ★ GITHUB IS IN THE POLICY, not outside it, and that is a security decision rather than a tidiness one. GitHub is a
 *    WRITE channel with the person's token: `git push` sends a workspace somewhere it can be read. Leaving it always-on
 *    under `none` would put back exactly the hole we refused on the registry side, where a relay that could not see a
 *    PUT was rejected for that reason alone. So `none` closes GitHub too — no push, no API, no raw fetch — because that
 *    is what the word has to mean once the attested story claims it. Custom can name these hosts explicitly.
 *    (witbitz-1c's review found them being served BEFORE the policy check: a workspace sealed `none` attested 0 hosts
 *    while five GitHub hosts were reachable with the real token. The story was lying, which is the worst failure this
 *    design has.) */
export const TRUSTED_HOSTS = [
  'api.github.com', 'codeload.github.com', 'files.pythonhosted.org', 'github.com',
  'objects.githubusercontent.com', 'pypi.org', 'raw.githubusercontent.com', 'registry.npmjs.org',
]

/** ★ The ONE channel outside the policy in every mode, including `none`: the model. Without it there is no agent at
 *  all. It is named in the UI rather than hidden, because "reaches nothing" would otherwise be a lie a person could
 *  act on — what you send the model is seen by the model, which is what the per-turn receipt is for. */
export const ALWAYS_ON = 'the model, through the Credential Sentinel'

const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/
const IPV4 = /^\d{1,3}(?:\.\d{1,3}){3}$/

/**
 * A hostname the person may add to a custom list. Deliberately narrow:
 *   · lower-cased, DNS labels only, at least two of them — a bare word is a typo or an internal name that will resolve
 *     to nothing here, and either way it should be rejected where it was typed;
 *   · never an IP literal — the allow-list is checked by NAME in both enforcers, so an address would be a hole that
 *     looks like an entry;
 *   · no wildcards. `.example.com` would let one entry stand for a domain the person has not seen, and the point of
 *     Custom is that they can read their own list. (The enclave's allow.go understands suffixes; we do not offer them.)
 */
export function normHost(h) {
  const s = String(h || '').trim().toLowerCase().replace(/\.$/, '')
  if (!s || s.length > 253 || IPV4.test(s) || s.includes('/') || s.includes(':') || s.includes('*')) return ''
  const parts = s.split('.')
  if (parts.length < 2 || !parts.every((p) => LABEL.test(p))) return ''
  if (!/^[a-z]{2,63}$/.test(parts[parts.length - 1])) return '' // a numeric or empty TLD is not a name
  return s
}

/**
 * A stored or typed policy → the canonical one, or null with a reason.
 * @returns {{ policy: {mode: string, hosts: string[]} } | { error: string }}
 */
export function normEgress(e) {
  const mode = String((e && e.mode) || 'none').trim().toLowerCase()
  if (mode === 'full') return { error: 'there is no unrestricted mode — choose the hosts this computer may reach' }
  if (!EGRESS_MODES.includes(mode)) return { error: `unknown mode "${mode.slice(0, 20)}"` }
  const raw = Array.isArray(e && e.hosts) ? e.hosts : []
  if (mode !== 'custom') {
    // ★ `trusted` carries no list of its own: its hosts are the IMAGE's, and are measured with it. A stored list here
    //   would be a second source of truth for something the attestation already answers.
    if (raw.length) return { error: `${mode} does not take a list of hosts` }
    return { policy: { mode, hosts: [] } }
  }
  const hosts = []
  for (const h of raw) {
    const n = normHost(h)
    if (!n) return { error: `"${String(h).slice(0, 40)}" is not a hostname this computer can be given` }
    if (!hosts.includes(n)) hosts.push(n)
  }
  if (!hosts.length) return { error: 'add at least one host, or choose another mode' }
  if (hosts.length > MAX_CUSTOM_HOSTS) return { error: `at most ${MAX_CUSTOM_HOSTS} hosts` }
  return { policy: { mode, hosts: hosts.sort() } }
}

/**
 * The exact bytes both sides hash. Sorted, lower-cased, one host per line under the mode — so the page and the enclave
 * agree on the preimage without sharing code.
 *
 * ★ IF THIS EVER DISAGREES WITH THE ENCLAVE'S CANONICAL FORM, the check it exists for silently passes nothing: every
 *   comparison would fail and the page would report drift that is not there, or — worse, if someone "fixes" it by
 *   comparing loosely — stop comparing at all. It is pinned by a vector in the tests on both sides.
 */
export function canonicalEgress(policy) {
  const p = (policy && policy.mode) ? policy : { mode: 'none', hosts: [] }
  return ['witbitz-egress-v1', p.mode, ...(p.hosts || []).slice().sort()].join('\n') + '\n' + (p.github ? '+github\n' : '') // github: GitHub connected (policy.go)
}

/** sha256 of the canonical form, hex — what the enclave reports as `policyHash` for the policy it LOADED. */
export async function egressHash(policy) {
  const bytes = new TextEncoder().encode(canonicalEgress(policy))
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

/** One line for a person: what this computer may reach, in words rather than a mode name. */
export function describeEgress(policy) {
  const p = (policy && policy.mode) ? policy : { mode: 'none', hosts: [] }
  // ★ Every sentence names the model channel, because it is on in every mode and a person reading "reaches nothing"
  //   would otherwise believe something false about where their work can go.
  // ★★ AND EVERY SENTENCE NAMES THE BROWSER (the owner, 2026-10-23: "my cloud computer in the regular app is completely
  //   open"). Since 2026-09-21 its browser reaches the whole web by construction (docs/cloud-computer-free-browsing.md),
  //   and the agent can drive it — so this mode limits the agent's OWN network only; "reaches nothing" alone was false.
  let own
  if (p.mode === 'none') own = `Its own network reaches nothing on the internet — only ${ALWAYS_ON}`
  else if (p.mode === 'trusted') own = `Its own network can fetch packages and reach GitHub (${TRUSTED_HOSTS.length} hosts), plus ${ALWAYS_ON}`
  else { const n = (p.hosts || []).length; own = `Its own network can reach ${n} host${n === 1 ? '' : 's'} you chose (${(p.hosts || []).join(', ')}), plus ${ALWAYS_ON}` }
  return `${own}. ${BROWSER_OPEN}`
}
/** The browser's half, the same in every mode. */
export const BROWSER_OPEN = 'Its browser reaches the whole web in every mode, and the agent can use it — so through the browser the agent can reach the web too.'
