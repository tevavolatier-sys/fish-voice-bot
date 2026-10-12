// 🗣 Texte « prononçable » : les chatters écrivent comme par SMS (« mdr »,
// « tkt », « jsp »…), la voix lirait ces abréviations lettre par lettre.
// On les remplace par les vrais mots (et « mdr / lol / 😂 » par « haha »)
// AVANT la mise en scène et la synthèse.

const B = (w: string) => new RegExp(`(?<![\\p{L}\\p{N}'])(?:${w})(?![\\p{L}\\p{N}'])`, "giu");

const SMS_FR: [RegExp, string][] = [
  [B("tkt"), "t'inquiète"], [B("jsp"), "je sais pas"], [B("stp"), "s'il te plaît"], [B("svp"), "s'il vous plaît"],
  [B("bcp"), "beaucoup"], [B("p[kq]"), "pourquoi"], [B("slt"), "salut"], [B("dsl"), "désolée"], [B("jtm"), "je t'aime"],
  [B("mtn|mnt"), "maintenant"], [B("tjrs?"), "toujours"], [B("qd"), "quand"], [B("ptn"), "putain"], [B("cc"), "coucou"],
  [B("bjr"), "bonjour"], [B("bsr"), "bonsoir"], [B("bsx|biz"), "bisous"], [B("jpp"), "j'en peux plus"], [B("pr"), "pour"],
  [B("ds"), "dans"], [B("avc"), "avec"], [B("tt"), "tout"], [B("rdv"), "rendez-vous"], [B("dmn"), "demain"], [B("auj"), "aujourd'hui"],
];
const SMS_EN: [RegExp, string][] = [
  [B("u"), "you"], [B("ur"), "your"], [B("rn"), "right now"], [B("tbh"), "to be honest"], [B("idk"), "I don't know"],
  [B("ily"), "I love you"], [B("omg"), "oh my god"], [B("pls|plz"), "please"], [B("thx"), "thanks"],
  [B("wyd"), "what are you doing"], [B("hbu"), "how about you"], [B("gn"), "good night"],
];
const LAUGH = /(?<![\p{L}\p{N}])(?:x?ptdr+|mdr+|lol+|lmf?ao+|xd+)(?![\p{L}\p{N}])|[😂🤣😆😹]+/giu;

export function speakable(text: string, lang: "fr" | "en" | "de" = "fr"): string {
  let s = text.normalize("NFC").replace(/\r?\n+/g, " ");
  s = s.replace(LAUGH, " haha ");
  const map = lang === "fr" ? SMS_FR : lang === "en" ? SMS_EN : [];
  for (const [re, w] of map) s = s.replace(re, (m) => (/^\p{Lu}/u.test(m) ? w[0].toUpperCase() + w.slice(1) : w));
  return s
    .replace(/(\p{L})\1{3,}/gu, "$1$1$1") // « trooooop » → « trooop »
    .replace(/[!?]{2,}/g, (m) => (m.includes("?") ? "?" : "!"))
    .replace(/\s+([,.!?])/g, "$1")
    .replace(/\s{2,}/g, " ")
    .trim();
}
