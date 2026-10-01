// Simulation de bout en bout de /ppv avec le VRAI webhook du bot.
// Telegram et Upstash Redis sont simulés (rien n'est envoyé à personne) ;
// Fish Audio est le VRAI (voix réelle de la modèle, quelques centimes) ;
// ffmpeg et toute la logique du bot sont les vrais.
// Les 2 vidéos produites (preview + PPV 1) sont enregistrées pour être regardées.
// Usage : FISH_API_KEY=… npx tsx scripts/sim-ppv.ts <dossier des vidéos 1080p> <dossier de sortie>
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import http, { createServer } from "node:http";
import https from "node:https";
import { join } from "node:path";

const PARTS_DIR = process.argv[2];
const OUT_DIR = process.argv[3];
mkdirSync(OUT_DIR, { recursive: true });
const partFiles = readdirSync(PARTS_DIR).filter((f) => f.endsWith(".mp4")).sort();
const GROUP = -1004454486728;
const ADMIN = 8202292569;
const OPERATOR = 111;

// ── Faux Upstash Redis ──────────────────────────────────────────────────────
const kv = new Map<string, string>();
const hashes = new Map<string, Map<string, number>>();
const lists = new Map<string, string[]>();
const sets = new Map<string, Set<string>>();
function exec(cmd: (string | number)[]): unknown {
  const [op, key, ...rest] = cmd.map(String);
  switch (op.toUpperCase()) {
    case "GET":
      return kv.get(key) ?? null;
    case "SET": {
      if (rest.map((r) => r.toUpperCase()).includes("NX") && kv.has(key)) return null;
      kv.set(key, rest[0]);
      return "OK";
    }
    case "DEL":
      return [key, ...rest].filter((k) => kv.delete(k) || hashes.delete(k) || lists.delete(k) || sets.delete(k)).length;
    case "HINCRBY": {
      const h = hashes.get(key) ?? new Map<string, number>();
      h.set(rest[0], (h.get(rest[0]) ?? 0) + Number(rest[1]));
      hashes.set(key, h);
      return h.get(rest[0]);
    }
    case "HGETALL":
      return [...(hashes.get(key) ?? new Map())].flatMap(([k, v]) => [k, String(v)]);
    case "SADD": {
      const s = sets.get(key) ?? new Set<string>();
      const before = s.size;
      rest.forEach((m) => s.add(m));
      sets.set(key, s);
      return s.size - before;
    }
    case "RPUSH": {
      const l = lists.get(key) ?? [];
      l.push(...rest);
      lists.set(key, l);
      return l.length;
    }
    case "LRANGE":
      return lists.get(key) ?? [];
    default:
      throw new Error(`commande Redis non simulée: ${op}`);
  }
}
const redis = createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    const parsed = JSON.parse(body || "[]");
    const b64 = String(req.headers["upstash-encoding"] ?? "").toLowerCase() === "base64";
    const enc = (v: unknown): unknown =>
      typeof v === "string" && b64 ? Buffer.from(v, "utf8").toString("base64") : Array.isArray(v) ? v.map(enc) : v;
    const out = req.url?.startsWith("/pipeline") || req.url?.startsWith("/multi-exec")
      ? (parsed as (string | number)[][]).map((c) => ({ result: enc(exec(c)) }))
      : { result: enc(exec(parsed)) };
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(out));
  });
});

// ── Faux Telegram ───────────────────────────────────────────────────────────
type Call = { method: string; body: Record<string, unknown>; at: number };
const calls: Call[] = [];
let nextMsg = 100;
let savedVideos = 0;

function multipart(buf: Buffer, contentType: string) {
  const boundary = contentType.match(/boundary=(?:"([^"]+)"|([^;]+))/i);
  const fields: Record<string, unknown> = {};
  let file: { name: string; data: Buffer } | null = null;
  if (!boundary) return { fields, file };
  const sep = Buffer.from(`--${boundary[1] ?? boundary[2]}`);
  let pos = buf.indexOf(sep);
  while (pos !== -1) {
    const next = buf.indexOf(sep, pos + sep.length);
    if (next === -1) break;
    const part = buf.subarray(pos + sep.length + 2, next - 2);
    const headEnd = part.indexOf("\r\n\r\n");
    const head = part.subarray(0, headEnd).toString("utf8");
    const data = part.subarray(headEnd + 4);
    const name = head.match(/name="([^"]+)"/)?.[1] ?? "";
    // grammy écrit « filename=xxx » sans guillemets
    const filename = head.match(/filename="?([^"\r\n;]+)"?/)?.[1];
    if (filename) file = { name: filename, data };
    else fields[name] = data.toString("utf8");
    pos = next;
  }
  return { fields, file };
}

const telegram = createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on("data", (c: Buffer) => chunks.push(c));
  req.on("end", () => {
    const method = (req.url ?? "").split("/").pop() ?? "";
    const buf = Buffer.concat(chunks);
    const ct = String(req.headers["content-type"] ?? "");
    let body: Record<string, unknown>;
    if (ct.includes("application/json")) body = JSON.parse(buf.toString("utf8") || "{}");
    else {
      const { fields, file } = multipart(buf, ct);
      body = fields;
      if (file && (method === "sendVideo" || method === "sendAudio")) {
        savedVideos += 1;
        const out = join(OUT_DIR, `${String(savedVideos).padStart(2, "0")}-${file.name}`);
        writeFileSync(out, file.data);
        body.saved = out;
        body.bytes = file.data.length;
      }
    }
    calls.push({ method, body, at: Date.now() });
    let result: unknown = true;
    if (method === "getMe") result = { id: 1, is_bot: true, first_name: "Voice", username: "voice_bot" };
    if (method === "sendMessage" || method === "sendVideo" || method === "sendAudio") {
      const id = nextMsg++;
      result = { message_id: id, date: 0, chat: { id: GROUP, type: "supergroup" } };
      if (method === "sendVideo") {
        (result as Record<string, unknown>).video = { file_id: `PART_${savedVideos}`, file_unique_id: `UV${id}`, width: 1920, height: 1080, duration: 25, file_size: Number(body.bytes ?? 0) };
      }
    }
    if (method === "getFile") {
      result = { file_id: String(body.file_id), file_unique_id: "x", file_path: `videos/${String(body.file_id)}` };
    }
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ ok: true, result }));
  });
});
let tgPort = 0;
const originalHttpsRequest = https.request;
(https as unknown as { request: unknown }).request = (opts: Record<string, unknown>, cb?: unknown) => {
  if (String(opts.hostname ?? opts.host ?? "") === "api.telegram.org") {
    return http.request(
      { ...opts, protocol: "http:", hostname: "127.0.0.1", host: "127.0.0.1", port: tgPort, agent: undefined },
      cb as never
    );
  }
  return (originalHttpsRequest as unknown as (o: unknown, c?: unknown) => unknown)(opts, cb);
};
const fishTexts: string[] = [];
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input instanceof Request ? input.url : input);
  // Téléchargement d'une vidéo PPV enregistrée : PART_n → vrai fichier 1080p
  if (url.startsWith("https://api.telegram.org/file/")) {
    const id = url.split("/").pop() ?? "";
    const n = Number(id.replace("PART_", ""));
    calls.push({ method: "downloadFile", body: { id }, at: Date.now() });
    return new Response(readFileSync(join(PARTS_DIR, partFiles[n - 1])), { status: 200 });
  }
  if (url.startsWith("https://api.fish.audio/v1/tts")) {
    fishTexts.push(String(JSON.parse(String(init?.body ?? "{}")).text));
  }
  return realFetch(input, init); // Fish Audio : le vrai
}) as typeof fetch;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFor(pred: () => boolean, label: string, ms = 90_000) {
  const t0 = Date.now();
  while (!pred()) {
    if (Date.now() - t0 > ms) {
      console.log("  appels :", calls.map((c) => `${c.method}${c.body.text ? ` «${String(c.body.text).slice(0, 70)}»` : ""}`));
      throw new Error(`délai dépassé : ${label}`);
    }
    await sleep(100);
  }
}
const lastText = () => String([...calls].reverse().find((c) => c.method === "sendMessage")?.body.text ?? "");

async function main() {
  await new Promise<void>((r) => redis.listen(0, r));
  await new Promise<void>((r) => telegram.listen(0, r));
  tgPort = (telegram.address() as { port: number }).port;
  process.env.UPSTASH_REDIS_REST_URL = `http://127.0.0.1:${(redis.address() as { port: number }).port}`;
  process.env.UPSTASH_REDIS_REST_TOKEN = "test";
  process.env.BOT_TOKEN = "1:TEST";
  process.env.TELEGRAM_WEBHOOK_SECRET = "s3cret";
  if (!process.env.FISH_API_KEY) throw new Error("FISH_API_KEY manquante");

  const { POST } = await import("../api/webhook.js");
  let uid = 1;
  const send = (update: Record<string, unknown>) =>
    POST(new Request("https://x/api/webhook", {
      method: "POST",
      headers: { "content-type": "application/json", "x-telegram-bot-api-secret-token": "s3cret" },
      body: JSON.stringify({ update_id: uid++, ...update }),
    }));
  const adminChat = { id: ADMIN, type: "private", first_name: "Teva" };
  const admin = { id: ADMIN, is_bot: false, first_name: "Teva" };
  const group = { id: GROUP, type: "supergroup", title: "VOICE BOT" };
  const op = { id: OPERATOR, is_bot: false, first_name: "Op" };
  const command = (text: string, chat = group, from = op) => {
    const cmdLen = text.split(" ")[0].length;
    return send({ message: { message_id: uid + 500, date: 0, chat, from, text, entities: [{ type: "bot_command", offset: 0, length: cmdLen }] } });
  };

  if (process.env.SIM_SETUP === "1") {
    // Enregistrement par la porte d'admin (morceaux de 700 Ko), sans Telegram
    process.env.PPV_SETUP_SECRET = "x".repeat(32);
    const hdr = { "x-setup-secret": process.env.PPV_SETUP_SECRET };
    for (const [k, f] of partFiles.entries()) {
      const data = readFileSync(join(PARTS_DIR, f));
      const id = `sim${k}`;
      const CH = 700_000;
      const n = Math.ceil(data.length / CH);
      for (let i = 0; i < n; i++) {
        const r = await POST(new Request(`https://x/api/webhook?setup=chunk&id=${id}&i=${i}`, { method: "POST", headers: hdr, body: data.subarray(i * CH, (i + 1) * CH) }));
        if (!r.ok) throw new Error(`morceau ${i}: ${await r.text()}`);
      }
      const fin = await POST(new Request(`https://x/api/webhook?setup=finish&id=${id}&n=${n}&name=${f}`, { method: "POST", headers: hdr }));
      console.log(`  porte d'admin : ${f} en ${n} morceaux → ${await fin.text()}`);
    }
    const bad = await POST(new Request("https://x/api/webhook?setup=list", { method: "POST", headers: { "x-setup-secret": "mauvais" } }));
    console.log(`  sans le bon secret → HTTP ${bad.status}`);
    const lst = await POST(new Request("https://x/api/webhook?setup=list", { method: "POST", headers: hdr }));
    console.log(`  liste → ${await lst.text()}`);
    const tst = await POST(new Request("https://x/api/webhook?setup=test&name=Test", { method: "POST", headers: hdr }));
    console.log(`  test → ${await tst.text()}`);
    await waitFor(() => calls.filter((c) => c.method === "sendVideo").length >= partFiles.length + 2, "2 vidéos du test");
    console.log("  " + calls.filter((c) => c.method === "sendVideo").slice(-2).map((c) => `${String(c.body.caption)} · chat ${c.body.chat_id}`).join("\n  "));
    redis.close();
    telegram.close();
    process.exit(0);
  }

  console.log(`▶ l'admin envoie les ${partFiles.length} vidéos en un album, légende /ppvadd (arrivées simultanées)`);
  await Promise.all(
    partFiles.map((f, i) =>
      send({
        message: {
          message_id: 10 + i, date: 0, chat: adminChat, from: admin, media_group_id: "ALBUM1",
          video: { file_id: `PART_${i + 1}`, file_unique_id: `UPART_${i + 1}`, width: 1920, height: 1080, duration: 25, file_size: statSync(join(PARTS_DIR, f)).size },
          ...(i === 0 ? { caption: "/ppvadd", caption_entities: [{ type: "bot_command", offset: 0, length: 7 }] } : {}),
        },
      })
    )
  );
  await waitFor(() => calls.filter((c) => c.method === "sendMessage" && String(c.body.text).includes("saved")).length === partFiles.length, "enregistrement");
  console.log("  " + calls.filter((c) => c.method === "sendMessage").map((c) => String(c.body.text)).join("\n  "));

  console.log("▶ /ppvlist");
  await command("/ppvlist", adminChat, admin);
  console.log("  " + lastText().split("\n").join("\n  "));

  console.log("▶ /ppvfixed (admin) : écouter les parties fixes, puis 🔁 nouvelle prise du PPV 1");
  await command("/ppvfixed", adminChat, admin);
  await waitFor(() => calls.filter((c) => c.method === "sendAudio").length === 2, "2 parties fixes");
  console.log("  " + calls.filter((c) => c.method === "sendAudio").map((c) => String(c.body.caption).split("\n").join(" — ")).join("\n  "));
  await send({ callback_query: { id: "fix1", from: admin, chat_instance: "1", data: "ppvfix:paid1", message: { message_id: 700, date: 0, chat: adminChat, text: "x" } } });
  await waitFor(() => calls.filter((c) => c.method === "sendAudio").length === 3, "nouvelle prise");
  console.log("  → " + String(calls.filter((c) => c.method === "sendAudio").pop()?.body.caption));

  console.log("▶ /ppv avec un prénom invalide");
  await command("/ppv 123");
  console.log("  → " + lastText().split("\n")[0]);

  console.log("▶ /ppv julien, puis un 2e /ppv tout de suite (doit être bloqué)");
  const t0 = Date.now();
  await command("/ppv julien");
  await command("/ppv julien");
  console.log("  → " + calls.filter((c) => c.method === "sendMessage").slice(-2).map((c) => String(c.body.text)).join("\n  → "));
  await waitFor(() => calls.filter((c) => c.method === "sendVideo").length === 2, "2 vidéos");
  console.log(`  ✔ 2 vidéos en ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  for (const c of calls.filter((x) => x.method === "sendVideo")) {
    console.log(`    · ${String(c.body.caption)} · ${(Number(c.body.bytes) / 1_048_576).toFixed(1)} Mo · ${c.body.width}×${c.body.height} · ${c.body.duration} s → ${c.body.saved}`);
  }
  console.log("  textes envoyés à Fish :\n    " + fishTexts.join("\n    "));

  console.log("▶ 2e fan : /ppv max (la partie fixe doit être identique)");
  const before2 = calls.filter((c) => c.method === "sendVideo").length;
  await sleep(500);
  await command("/ppv max");
  await waitFor(() => calls.filter((c) => c.method === "sendVideo").length === before2 + 2, "2 vidéos de Max");
  console.log("  " + calls.filter((c) => c.method === "sendVideo").slice(-2).map((c) => `${String(c.body.caption)} → ${c.body.saved}`).join("\n  "));

  // ── Boutons de volume : refaire la vidéo PPV 1 à d'autres niveaux ──
  // Attendre la fin des DEUX PPV (Julien puis Max) : un opérateur = un PPV à la fois
  await waitFor(() => calls.filter((c) => c.method === "sendMessage" && String(c.body.text).startsWith("🔊")).length >= 2, "boutons de volume");
  await sleep(800);
  const volMsg = calls.filter((c) => c.method === "sendMessage" && String(c.body.text).startsWith("🔊")).pop()!;
  const kb = volMsg.body.reply_markup as { inline_keyboard: { text: string; callback_data: string }[][] };
  console.log("▶ boutons sous le PPV : " + kb.inline_keyboard[0].map((b) => b.text).join(" | "));
  const fishBefore = fishTexts.length;
  for (const lvl of [1, 3, 5]) {
    const btn = kb.inline_keyboard[0].find((b) => b.callback_data.endsWith(`:${lvl}`))!;
    const before = calls.filter((c) => c.method === "sendVideo").length;
    await send({
      callback_query: {
        id: `cb${lvl}`, from: op, chat_instance: "1", data: btn.callback_data,
        message: { message_id: 900 + lvl, date: 0, chat: group, text: String(volMsg.body.text) },
      },
    });
    await waitFor(() => calls.filter((c) => c.method === "sendVideo").length === before + 1, `volume ${lvl}`);
    const vids = calls.filter((c) => c.method === "sendVideo").slice(-1);
    console.log(`  volume ${lvl} → ${vids.map((v) => String(v.body.caption)).join(" · ")}`);
    await sleep(300);
  }
  console.log(`  appels Fish pendant les refontes : ${fishTexts.length - fishBefore} (doit être 0)`);
  redis.close();
  telegram.close();
  process.exit(0);
}

main().catch((err) => {
  console.error("❌", err);
  process.exit(1);
});
