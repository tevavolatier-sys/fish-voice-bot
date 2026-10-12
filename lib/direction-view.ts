// 👁 Aperçu lisible de la mise en scène, pour le chatter (légende Telegram en
// HTML) : directions en italique, sons en emojis, mots chuchotés soulignés,
// mots appuyés en gras.

const esc = (t: string) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

// Son → emoji (le 1er motif qui correspond)
const SOUNDS: [RegExp, string][] = [
  [/scream|cry(ing)? out|cry of pleasure/i, "😩"],
  [/moan/i, "🥵"],
  [/whimper|begging/i, "🥺"],
  [/gasp/i, "😮"],
  [/pant|heavy breath/i, "💦"],
  [/sigh/i, "😮‍💨"],
  [/breath/i, "💨"],
  [/laugh|giggle|chuckl/i, "😄"],
  [/long pause/i, "⏸⏸"],
  [/pause/i, "⏸"],
  [/hum/i, "🎵"],
  [/lip smack|kiss/i, "💋"],
];

/** Un crochet court qui nomme un bruit = un son ; sinon c'est une direction */
function bracket(content: string): string {
  const c = content.trim();
  const words = c.split(/\s+/).length;
  if (words <= 4) {
    const hit = SOUNDS.find(([re]) => re.test(c));
    if (hit && !/,/.test(c)) return hit[1];
  }
  return `🎬<i>${esc(c)}</i>`;
}

const OPEN: Record<string, string> = {
  whisper: "🤫<u>",
  soft: "<u>",
  slow: "<u>",
  emphasis: "<b>",
  stress: "<b>",
  forceful: "<b>",
  fast: "<u>",
};
const CLOSE: Record<string, string> = {
  whisper: "</u>",
  soft: "</u>",
  slow: "</u>",
  emphasis: "</b>",
  stress: "</b>",
  forceful: "</b>",
  fast: "</u>",
};

/** Texte mis en scène → HTML Telegram lisible */
export function directionView(directed: string): string {
  let out = "";
  let last = 0;
  for (const m of directed.matchAll(/\[([^\]]*)\]|<(\/?)([a-z]+)>/gi)) {
    out += esc(directed.slice(last, m.index));
    if (m[1] !== undefined) out += bracket(m[1]);
    else {
      const tag = m[3].toLowerCase();
      out += m[2] ? CLOSE[tag] ?? "" : OPEN[tag] ?? "";
    }
    last = (m.index ?? 0) + m[0].length;
  }
  out += esc(directed.slice(last));
  return out.replace(/\s{2,}/g, " ").trim();
}

/** Longueur visible (sans les balises HTML) — la légende Telegram est limitée à 1024 */
export const visibleLength = (html: string) =>
  html.replace(/<[^>]+>/g, "").replace(/&(amp|lt|gt);/g, "x").length;
