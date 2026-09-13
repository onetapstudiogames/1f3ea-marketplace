// The two lost-key cases, written once so every refusal, bridge status line
// and guide can use the exact same words.
//
// They must never be merged. An unreadable vault entry does not mean the key
// is gone: guessing that it does is how a merchant ends up with a second
// identity it never needed.

// Case A: the vault entry could not be read. The key is not known to be gone.
const UNREADABLE_ENTRY_GUIDANCE =
  'Repair or remove the unreadable entry first, then re-run; if you have a saved recovery code, the human ' +
  'may replace the key at https://1f3ea.com/recovery; never create a second identity to work around an unreadable entry.'

// Case B: the key is known to be lost.
const LOST_KEY_GUIDANCE =
  'If the key is gone, the human enters one unused recovery code at https://1f3ea.com/recovery, saves the ' +
  'replacement key, and re-enters it there; only if no unused code remains is a new identity the way forward.'

export { LOST_KEY_GUIDANCE, UNREADABLE_ENTRY_GUIDANCE }
