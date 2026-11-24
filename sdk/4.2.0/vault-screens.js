// vault-screens.js — the DEFAULT screens of a builder-hosted vault (docs/sdk-vault-mode.md). A builder replaces any of
// them: each is a function vault-core.js calls with what it needs, and resolves when the person is done.
//
//   signIn({ email, sendCode(email), verify(email, code) })  → resolves once verify() succeeded (or rejects: cancelled)
//   share({ link, title })                                   → shows the invite link to copy / share; resolves when closed
//   confirm({ title, text, ok, cancel })                     → resolves true / false (removing a Space, signing out, joining one)
//   recoveryCode({ code })                                   → shows the account's recovery code ONCE; resolves when the person is done
//   restore({ email, restore({ code, email?, ticket?, emailCode? }) }) → takes a recovery code (and, where the backup's gate
//                                                              asks, the email and the code mailed to it); resolves once restored
//   emailCode({ email, purpose })                            → the code the Witbitz account service emailed to `email` (a new account,
//                                                              signing out other devices, a new recovery code, deleting the account —
//                                                              `purpose`: 'create' | 'signout' | 'newcode' | 'delete'); with no `email`,
//                                                              asks for the address and resolves THAT. Rejects: cancelled
//   siriKey({ key, endpoint })                               → shows the Siri Shortcut's key to put in the Shortcut; resolves when done
//   peerToken({ name, token, cardUrl, mcpUrl })              → shows an outside agent's token ONCE (with the assistant's address); resolves when done
//   failed({ page })                                         → the page did not load
//   ready()                                                  → the page said hello (hide a splash, if you drew one)
//   lockUi()                                                 → ONLY for a vault started with `lock: true`: puts the lock screen and
//                                                              the lock sheet in the page, hidden. Yours may restyle them freely, but
//                                                              keep the element ids (spaceLock.js drives them): #lockscreen
//                                                              (#unlockBtn #lockErr #lockReset, and a <p> it words) · #lockset
//                                                              (#lockToggle #lockOn #lockOff #lockAuto #lockProtect #lockProtectMsg
//                                                              #lockMsg #lockDesc #lockToggleLbl #lockClose)
//
// Plain DOM, no framework, styles scoped under .wbv- so a builder's own CSS is not disturbed. Text is set with
// textContent — an email or a title is never parsed as HTML.

const CSS = `
.wbv-scrim{position:fixed;inset:0;z-index:2147483000;background:rgba(0,0,0,.38);display:flex;align-items:center;justify-content:center;padding:16px;font:15px/1.4 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif}
.wbv-card{width:min(420px,100%);background:var(--wbv-bg,#fff);color:var(--wbv-fg,#111);border-radius:22px;padding:22px 20px 18px;box-shadow:0 12px 40px rgba(0,0,0,.25);display:flex;flex-direction:column;gap:12px}
.wbv-card h2{margin:0;font-size:19px;font-weight:650}
.wbv-card p{margin:0;color:var(--wbv-muted,#666)}
.wbv-card input{font:inherit;font-size:16px;padding:12px 14px;border-radius:12px;border:1px solid var(--wbv-line,#ddd);background:var(--wbv-field,#f6f6f6);color:inherit;width:100%;box-sizing:border-box}
.wbv-row{display:flex;gap:8px;justify-content:flex-end}
.wbv-btn{font:inherit;font-weight:600;border:0;border-radius:999px;padding:10px 18px;cursor:pointer;background:var(--wbv-field,#eee);color:inherit}
.wbv-btn.wbv-go{background:var(--wbv-accent,#111);color:#fff}
.wbv-err{color:#d33;min-height:1.2em;font-size:14px}
@media (prefers-color-scheme: dark){.wbv-card{--wbv-bg:#262626;--wbv-fg:#f2f2f2;--wbv-muted:#aaa;--wbv-line:#3a3a3a;--wbv-field:#333}}
.wbv-lock{background:var(--wbv-cover,#f2f2f2)}
@media (prefers-color-scheme: dark){.wbv-lock{--wbv-cover:#111}}
.wbv-card label{display:flex;gap:10px;align-items:center}
.wbv-card input[type=checkbox]{width:auto;padding:0}
.wbv-card select{font:inherit;padding:8px 10px;border-radius:10px;border:1px solid var(--wbv-line,#ddd);background:var(--wbv-field,#f6f6f6);color:inherit}
.wbv-sw{min-width:52px}.wbv-sw[aria-checked=true]{background:var(--wbv-accent,#111);color:#fff}
`
let styled = false
const style = (accent) => {
  if (!styled) { const s = document.createElement('style'); s.textContent = CSS; document.head.append(s); styled = true }
  if (accent) document.documentElement.style.setProperty('--wbv-accent', accent)
}
const el = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n }
function card(title, sub) {
  const scrim = el('div', 'wbv-scrim'), c = el('div', 'wbv-card')
  c.setAttribute('role', 'dialog'); c.setAttribute('aria-modal', 'true')
  c.append(el('h2', '', title)); if (sub) c.append(el('p', '', sub))
  scrim.append(c); document.body.append(scrim)
  return { scrim, c, close: () => scrim.remove() }
}

/** The default screens, in your brand. @param {{ brand?: string, accent?: string }} [o] */
export function defaultScreens({ brand = 'this app', accent = '' } = {}) {
  style(accent)
  return {
    signIn({ email = '', sendCode, verify }) {
      return new Promise((resolve, reject) => {
        const { c, close } = card('Sign in to ' + brand, 'We email you a six-digit code.')
        const input = el('input'); input.type = 'email'; input.autocomplete = 'email'; input.placeholder = 'you@example.com'; input.value = email
        const err = el('div', 'wbv-err')
        const row = el('div', 'wbv-row'), cancel = el('button', 'wbv-btn', 'Cancel'), go = el('button', 'wbv-btn wbv-go', 'Email me a code')
        row.append(cancel, go); c.append(input, err, row)
        let addr = '', step = 'email'
        cancel.onclick = () => { close(); reject(Object.assign(new Error('cancelled'), { code: 'sign_in_cancelled' })) }
        go.onclick = async () => {
          err.textContent = ''; go.disabled = true
          try {
            if (step === 'email') {
              addr = input.value.trim()
              await sendCode(addr)
              step = 'code'; input.value = ''; input.type = 'text'; input.inputMode = 'numeric'; input.autocomplete = 'one-time-code'; input.placeholder = '6-digit code'
              go.textContent = 'Sign in'
              c.querySelector('p').textContent = 'We sent a code to ' + addr + '.'
            } else {
              await verify(addr, input.value.trim())
              close(); resolve({ email: addr })
            }
          } catch (e) { err.textContent = step === 'email' ? 'Could not send a code to that address.' : 'That code did not work. Check it and try again.' }
          go.disabled = false; input.focus()
        }
        input.onkeydown = (e) => { if (e.key === 'Enter') go.click() }
        input.focus()
      })
    },
    share({ link, title = '' }) {
      return new Promise((resolve) => {
        const { c, close } = card(title ? 'Invite to ' + title : 'Invite someone', 'Anyone with this link can join. Send it only to people you mean to.')
        const input = el('input'); input.readOnly = true; input.value = link
        const row = el('div', 'wbv-row'), done = el('button', 'wbv-btn', 'Done'), copy = el('button', 'wbv-btn wbv-go', 'Copy link')
        row.append(done)
        if (navigator.share) { const sh = el('button', 'wbv-btn', 'Share…'); sh.onclick = () => navigator.share({ url: link, title: title || brand }).catch(() => {}); row.append(sh) }
        row.append(copy); c.append(input, row)
        copy.onclick = async () => { try { await navigator.clipboard.writeText(link); copy.textContent = 'Copied' } catch { input.select() } }
        done.onclick = () => { close(); resolve() }
      })
    },
    confirm({ title, text = '', ok = 'OK', cancel = 'Cancel' }) {
      return new Promise((resolve) => {
        const { c, close } = card(title, text)
        const row = el('div', 'wbv-row'), no = el('button', 'wbv-btn', cancel), yes = el('button', 'wbv-btn wbv-go', ok)
        no.onclick = () => { close(); resolve(false) }
        yes.onclick = () => { close(); resolve(true) }
        row.append(no, yes); c.append(row); yes.focus()
      })
    },
    recoveryCode({ code }) {
      return new Promise((resolve) => {
        const { c, close } = card('Your recovery code', 'Keep it somewhere safe — it is the only way to get your Spaces back on a new device. It is shown once.')
        const box = el('input'); box.readOnly = true; box.value = code; box.style.fontFamily = 'ui-monospace,Menlo,monospace'; box.style.letterSpacing = '.06em'
        const row = el('div', 'wbv-row'), copy = el('button', 'wbv-btn', 'Copy'), done = el('button', 'wbv-btn wbv-go', 'I saved it')
        copy.onclick = async () => { try { await navigator.clipboard.writeText(code); copy.textContent = 'Copied' } catch { box.select() } }
        done.onclick = () => { close(); resolve() }
        row.append(copy, done); c.append(box, row)
      })
    },
    emailCode({ email = '', purpose = '' }) {
      return new Promise((resolve, reject) => {
        const asksAddress = !email
        const noCode = purpose === 'create' ? ' If this email already has a ' + brand + ' account, nothing is sent — restore it with your recovery code instead.' : ''
        const { c, close } = card(asksAddress ? 'Your email' : 'Check your email', asksAddress ? 'The email address of your ' + brand + ' account. We’ll send it a code.' : 'We sent a 6-digit code to ' + email + '.' + noCode)
        const input = el('input')
        if (asksAddress) { input.type = 'email'; input.autocomplete = 'email'; input.placeholder = 'you@example.com' } else { input.inputMode = 'numeric'; input.autocomplete = 'one-time-code'; input.placeholder = '6-digit code' }
        const row = el('div', 'wbv-row'), cancel = el('button', 'wbv-btn', 'Cancel'), go = el('button', 'wbv-btn wbv-go', asksAddress ? 'Send me a code' : 'Continue')
        row.append(cancel, go); c.append(input, row)
        cancel.onclick = () => { close(); reject(Object.assign(new Error('cancelled'), { code: 'cancelled' })) }
        go.onclick = () => { const v = input.value.trim(); if (!v) { input.focus(); return } close(); resolve(v) }
        input.onkeydown = (e) => { if (e.key === 'Enter') go.click() }
        input.focus()
      })
    },
    siriKey({ key }) {
      return new Promise((resolve) => {
        const { c, close } = card('Your Siri key', 'Put it in the Shortcut. Anyone who has it can send words into your Spaces — make a new one if it leaks.')
        const box = el('input'); box.readOnly = true; box.value = key; box.style.fontFamily = 'ui-monospace,Menlo,monospace'
        const row = el('div', 'wbv-row'), copy = el('button', 'wbv-btn', 'Copy'), done = el('button', 'wbv-btn wbv-go', 'Done')
        copy.onclick = async () => { try { await navigator.clipboard.writeText(key); copy.textContent = 'Copied' } catch { box.select() } }
        done.onclick = () => { close(); resolve() }
        row.append(copy, done); c.append(box, row)
      })
    },
    // an outside agent's token: what the agent presents as its bearer for as long as it lives — shown here, never to the page
    // (sync sweep 2026-11-14 #3; the hosted vault does the same, vaultPeerTokens.js)
    peerToken({ name = '', token, cardUrl = '', mcpUrl = '' }) {
      return new Promise((resolve) => {
        const { c, close } = card('Token for ' + (name || 'the outside agent'), 'Give it to the agent with your assistant\u2019s address. It is shown once — anyone who has it can message your assistant; remove the agent if it leaks.')
        const field = (v) => { const b = el('input'); b.readOnly = true; b.value = v; b.style.fontFamily = 'ui-monospace,Menlo,monospace'; return b }
        const box = field(token)
        const row = el('div', 'wbv-row'), copy = el('button', 'wbv-btn', 'Copy token'), done = el('button', 'wbv-btn wbv-go', 'Done')
        copy.onclick = async () => { try { await navigator.clipboard.writeText(token); copy.textContent = 'Copied' } catch { box.select() } }
        done.onclick = () => { close(); resolve() }
        row.append(copy, done)
        c.append(box, ...[mcpUrl, cardUrl].filter(Boolean).map(field), row)
      })
    },
    restore({ email = '', restore }) {
      return new Promise((resolve, reject) => {
        const { c, close } = card('Restore your Spaces', 'Type your recovery code.')
        const input = el('input'); input.placeholder = 'XXXX-XXXX-…'; input.autocomplete = 'off'
        const err = el('div', 'wbv-err')
        const row = el('div', 'wbv-row'), cancel = el('button', 'wbv-btn', 'Cancel'), go = el('button', 'wbv-btn wbv-go', 'Restore')
        row.append(cancel, go); c.append(input, err, row)
        let code = '', addr = email, ticket = '', step = 'code'
        cancel.onclick = () => { close(); reject(Object.assign(new Error('cancelled'), { code: 'cancelled' })) }
        const ask = (what, placeholder, type = 'text') => { step = what; input.value = ''; input.type = type; input.placeholder = placeholder; input.focus() }
        go.onclick = async () => {
          err.textContent = ''; go.disabled = true
          try {
            if (step === 'code') code = input.value.trim()
            else if (step === 'email') addr = input.value.trim()
            await restore(step === 'emailCode' ? { code, email: addr, ticket, emailCode: input.value.trim() } : { code, email: addr || undefined })
            close(); resolve()
          } catch (e) {
            const k = e && e.code
            if (k === 'email_required') { c.querySelector('p').textContent = 'This backup also needs the email it was set up with.'; ask('email', 'you@example.com', 'email') }
            else if (k === 'email_code_required') { ticket = e.ticket || ''; c.querySelector('p').textContent = 'We emailed a code to ' + addr + '.'; ask('emailCode', '6-digit code') }
            else err.textContent = k === 'bad_code' || k === 'not_found' ? 'That recovery code did not open a backup.' : k === 'email_code_wrong' ? 'That email code did not work.' : 'The backup could not be restored. Try again.'
          }
          go.disabled = false
        }
        input.onkeydown = (e) => { if (e.key === 'Enter') go.click() }
        input.focus()
      })
    },
    lockUi() {
      if (document.getElementById('lockscreen')) return
      const hidden = (n) => { n.style.display = 'none'; return n }
      const withId = (n, id) => { n.id = id; return n }
      // the LOCK SCREEN: opaque, over everything — the page is not framed (or is hidden) behind it
      const scr = hidden(withId(el('div', 'wbv-scrim wbv-lock'), 'lockscreen')), c = el('div', 'wbv-card')
      const reset = hidden(withId(el('button', 'wbv-btn', 'Start over'), 'lockReset'))
      const rowL = el('div', 'wbv-row'); rowL.append(reset, withId(el('button', 'wbv-btn wbv-go', 'Unlock'), 'unlockBtn'))
      c.append(el('h2', '', brand + ' is locked'), el('p', '', ''), withId(el('div', 'wbv-err'), 'lockErr'), rowL); scr.append(c)
      // the LOCK SHEET: the switch, when it locks again, and "Also protect this device's storage"
      const set = hidden(withId(el('div', 'wbv-scrim'), 'lockset')), s = el('div', 'wbv-card')
      s.setAttribute('role', 'dialog'); s.setAttribute('aria-modal', 'true')
      const head = el('div', 'wbv-row'); head.style.justifyContent = 'space-between'; head.style.alignItems = 'center'
      const sw = withId(el('button', 'wbv-btn wbv-sw', ''), 'lockToggle'); sw.setAttribute('role', 'switch'); sw.setAttribute('aria-checked', 'false')
      head.append(withId(el('h2', '', 'Lock'), 'lockToggleLbl'), sw)
      const auto = withId(el('select'), 'lockAuto')
      for (const [v, t] of [['0', 'only when it opens'], ['1', 'after 1 minute away'], ['5', 'after 5 minutes away'], ['15', 'after 15 minutes away'], ['60', 'after an hour away']]) { const o = el('option', '', t); o.value = v; auto.append(o) }
      const lAuto = el('label', '', 'Lock '); lAuto.append(auto)
      const box = withId(el('input'), 'lockProtect'); box.type = 'checkbox'
      const lBox = el('label'); lBox.append(box, el('span', '', 'Also protect this device’s storage — your keys are encrypted until you unlock'))
      const rowS = el('div', 'wbv-row'); rowS.append(hidden(withId(el('button', 'wbv-btn', 'Turn off'), 'lockOff')), hidden(withId(el('button', 'wbv-btn', 'Turn on'), 'lockOn')), withId(el('button', 'wbv-btn wbv-go', 'Done'), 'lockClose'))
      s.append(head, withId(el('p', '', ''), 'lockDesc'), lAuto, lBox, withId(el('p', '', ''), 'lockProtectMsg'), withId(el('div', 'wbv-err'), 'lockMsg'), rowS); set.append(s)
      document.body.append(scr, set)
    },
    failed({ page }) {
      const { c } = card(brand + ' didn’t load', 'Check your connection and try again.')
      const row = el('div', 'wbv-row'), again = el('button', 'wbv-btn wbv-go', 'Try again')
      again.onclick = () => location.reload(); row.append(again); c.append(row)
      void page
    },
    ready() {},
  }
}
