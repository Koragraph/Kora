// What a human actually TYPED into a worker pane, out of the raw bytes a terminal frontend sent (Runtime.humanWrite).
//
// A frontend sends far more than keystrokes: mouse reports (SGR `ESC [ < 35 ; 12 ; 40 M`, X10 `ESC [ M b x y`), focus
// in/out (`ESC [ I` / `ESC [ O`), bracketed-paste markers, cursor/colour query replies, DCS/OSC/APC replies such as
// XTVERSION. The old cleaner's CSI pattern had no `<` in its parameter bytes, so an SGR mouse report lost only its ESC
// and `[<35;12;40M` reached the lead as a "human steer" (live, 2026-10-14). The byte stream can also be cut between
// writes, leaving an ESC-less fragment (`[<0;5;9m`) at the start of the next chunk. Everything here is removed first;
// backspace/DEL edits are applied; what remains must contain a word to count.

// eslint-disable-next-line no-control-regex
const STRING_SEQ = /\x1b[P_^\]X][\s\S]*?(?:\x1b\\|\x07|$)/g;          // DCS / APC / PM / OSC / SOS (to ST or BEL, or the end)
// eslint-disable-next-line no-control-regex
const X10_MOUSE = /\x1b\[M[\s\S]{3}/g;                               // ESC [ M Cb Cx Cy (legacy mouse: 3 raw bytes)
// eslint-disable-next-line no-control-regex
const CSI = /\x1b\[[0-?]*[ -/]*[@-~]/g;                              // every CSI: params 0x30–0x3F include < = > ? : ;
// eslint-disable-next-line no-control-regex
const SS3 = /\x1bO[\s\S]/g;                                          // ESC O x (application-mode arrows / F1–F4)
// eslint-disable-next-line no-control-regex
const ESC_OTHER = /\x1b[\s\S]?/g;                                    // any other ESC + one byte (and a lone trailing ESC)
// ESC-less leftovers of a split sequence: `[<35;12;40M`, `[<0;5;9m`, `<35;12;40M`, `[200~`, `[I`, `[O`.
const MOUSE_FRAGMENT = /\[?<\d+;\d+(?:;\d+)?[Mm]?|\b\d+;\d+;\d+[Mm]/g;
const CSI_FRAGMENT = /\[\d+(?:;\d+)*[~A-DFHP-S]|^\[[IO]|\[[IO]$/g;

/** The text a human typed, or '' when the line is only terminal noise. */
export function cleanSteerText(raw: string): string {
  let s = raw
    .replace(STRING_SEQ, '')
    .replace(X10_MOUSE, '')
    .replace(CSI, '')
    .replace(SS3, '')
    .replace(ESC_OTHER, '');
  // Apply line editing the way the agent's input box did: BS / DEL delete the char before them; ^U / ^W clear.
  let out = '';
  for (const ch of s) {
    if (ch === '\x7f' || ch === '\b') { out = Array.from(out).slice(0, -1).join(''); continue; }
    if (ch === '\x15') { out = ''; continue; }
    if (ch === '\x17') { out = out.replace(/\S+\s*$/, ''); continue; }
    out += ch;
  }
  // eslint-disable-next-line no-control-regex
  s = out.replace(/[\x00-\x1f\x7f]/g, '').replace(MOUSE_FRAGMENT, '').replace(CSI_FRAGMENT, '').replace(/\s+/g, ' ').trim();
  return s;
}

/** A cleaned line is a steer only if it holds actual words: a run of 2+ letters (any script), and is at least 3 chars. */
export function isSteerText(text: string): boolean {
  return text.length >= 3 && /\p{L}{2,}/u.test(text);
}
