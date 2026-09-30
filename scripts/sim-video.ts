// Simulation de bout en bout du bouton 🎬, avec le VRAI webhook du bot :
// Telegram, Fish Audio et Upstash Redis sont simulés (rien n'est envoyé),
// ffmpeg et toute la logique du bot sont les vrais.
// Usage :  npx tsx scripts/sim-video.ts <fichier.mp3 d'une vraie voix>
import { readFileSync, writeFileSync } from "node:fs";
import http, { createServer } from "node:http";
import https from "node:https";

const voiceMp3 = readFileSync(process.argv[2]);
const GROUP = -1004454486728; // groupe VOICE BOT autorisé
const USER = 111;

// ── Faux Upstash Redis (REST) ─────────────────────────────────────────────
const kv = new Map<string, string>();
const hashes = new Map<string, Map<string, number>>();
function exec(cmd: (string | number)[]): unknown {
  const [op, key, ...rest] = cmd.map(String);
  switch (op.toUpperCase()) {
    case "GET":
      return kv.get(key) ?? null;
    case "SET": {
      const nx = rest.map((r) => r.toUpperCase()).includes("NX");
      if (nx && kv.has(key)) return null;
      kv.set(key, rest[0]);
      return "OK";
    }
    case "DEL":
      return [key, ...rest].filter((k) => kv.delete(k) || hashes.delete(k)).length;
    case "HINCRBY": {
      const h = hashes.get(key) ?? new Map<string, number>();
      h.set(rest[0], (h.get(rest[0]) ?? 0) + Number(rest[1]));
      hashes.set(key, h);
      return h.get(rest[0]);
    }
    case "HGETALL":
      return [...(hashes.get(key) ?? new Map())].flatMap(([k, v]) => [k, String(v)]);
    default:
      throw new Error(`commande Redis non simulée: ${op}`);
  }
}
const redis = createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    const parsed = JSON.parse(body || "[]");
    // Le client Upstash demande des réponses encodées en base64
    const b64 = String(req.headers["upstash-encoding"] ?? "").toLowerCase() === "base64";
    const enc = (v: unknown): unknown =>
      typeof v === "string" && b64
        ? Buffer.from(v, "utf8").toString("base64")
        : Array.isArray(v)
          ? v.map(enc)
          : v;
    const out = req.url?.startsWith("/pipeline") || req.url?.startsWith("/multi-exec")
      ? (parsed as (string | number)[][]).map((c) => ({ result: enc(exec(c)) }))
      : { result: enc(exec(parsed)) };
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(out));
  });
});

// ── Faux Telegram (serveur local) + faux Fish (interception de fetch) ─────
// grammy passe par node-fetch → https.request : on redirige api.telegram.org
// vers un serveur local. Fish Audio passe par le fetch global de Node.
type Call = { method: string; body: Record<string, unknown>; bytes?: number };
const calls: Call[] = [];
let nextMsg = 100;
function parseBody(buf: Buffer, contentType: string): Record<string, unknown> {
  if (contentType.includes("application/json")) return JSON.parse(buf.toString("utf8") || "{}");
  const json: Record<string, unknown> = {};
  const text = buf.toString("latin1");
  for (const m of text.matchAll(/name="([^"]+)"\r\n\r\n([^\r]*)\r\n/g)) {
    json[m[1]] = Buffer.from(m[2], "latin1").toString("utf8");
  }
  return json;
}
const telegram = createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on("data", (c: Buffer) => chunks.push(c));
  req.on("end", () => {
    const url = req.url ?? "";
    if (url.startsWith("/file/")) {
      res.end(voiceMp3); // téléchargement du vocal
      return;
    }
    const method = url.split("/").pop() ?? "";
    const buf = Buffer.concat(chunks);
    const json = parseBody(buf, String(req.headers["content-type"] ?? ""));
    calls.push({ method, body: json, bytes: buf.length });
    let result: unknown = true;
    if (method === "getMe") result = { id: 1, is_bot: true, first_name: "Voice", username: "voice_bot" };
    if (method === "sendVoice") {
      const id = nextMsg++;
      result = { message_id: id, date: 0, chat: { id: GROUP, type: "supergroup" }, voice: { file_id: `FILE_${id}`, file_unique_id: `U${id}`, duration: 3 } };
    }
    if (method === "sendMessage" || method === "sendVideo") {
      result = { message_id: nextMsg++, date: 0, chat: { id: GROUP, type: "supergroup" } };
    }
    if (method === "getFile") result = { file_id: String(json.file_id), file_unique_id: "x", file_path: "voice/file.mp3" };
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ ok: true, result }));
  });
});
let tgPort = 0;
const originalHttpsRequest = https.request;
(https as unknown as { request: unknown }).request = (opts: Record<string, unknown>, cb?: unknown) => {
  const host = String(opts.hostname ?? opts.host ?? "");
  if (host === "api.telegram.org") {
    return http.request(
      { ...opts, protocol: "http:", hostname: "127.0.0.1", host: "127.0.0.1", port: tgPort, agent: undefined },
      cb as never
    );
  }
  return (originalHttpsRequest as unknown as (o: unknown, c?: unknown) => unknown)(opts, cb);
};
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input instanceof Request ? input.url : input);
  if (url.startsWith("https://api.fish.audio/")) return new Response(voiceMp3, { status: 200 });
  // Téléchargement du vocal par le bouton 🎬 (fetch natif, pas grammy)
  if (url.startsWith("https://api.telegram.org/file/")) {
    calls.push({ method: "downloadFile", body: {} });
    return new Response(voiceMp3, { status: 200 });
  }
  return realFetch(input, init);
}) as typeof fetch;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFor(pred: () => boolean, label: string, ms = 30_000) {
  const t0 = Date.now();
  while (!pred()) {
    if (Date.now() - t0 > ms) {
      console.log("  appels Telegram :", calls.map((c) => `${c.method}${c.body.text ? ` «${String(c.body.text).slice(0, 80)}»` : ""}`));
      console.log("  redis :", [...kv.keys()]);
      throw new Error(`délai dépassé : ${label}`);
    }
    await sleep(50);
  }
}

async function main() {
  await new Promise<void>((r) => redis.listen(0, r));
  await new Promise<void>((r) => telegram.listen(0, r));
  tgPort = (telegram.address() as { port: number }).port;
  const port = (redis.address() as { port: number }).port;
  process.env.UPSTASH_REDIS_REST_URL = `http://127.0.0.1:${port}`;
  process.env.UPSTASH_REDIS_REST_TOKEN = "test";
  process.env.BOT_TOKEN = "1:TEST";
  process.env.FISH_API_KEY = "test";
  process.env.TELEGRAM_WEBHOOK_SECRET = "s3cret";
  delete process.env.GEMINI_API_KEY;
  delete process.env.GROQ_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;

  const { POST } = await import("../api/webhook.js");
  let uid = 1;
  const send = (update: Record<string, unknown>) =>
    POST(
      new Request("https://x/api/webhook", {
        method: "POST",
        headers: { "content-type": "application/json", "x-telegram-bot-api-secret-token": "s3cret" },
        body: JSON.stringify({ update_id: uid++, ...update }),
      })
    );
  const from = { id: USER, is_bot: false, first_name: "Op" };
  const chat = { id: GROUP, type: "supergroup", title: "VOICE BOT" };
  const callback = (data: string, message?: Record<string, unknown>) =>
    send({
      callback_query: {
        id: `cb${uid}`,
        from,
        chat_instance: "1",
        data,
        message: message ?? { message_id: 50, date: 0, chat, text: "x" },
      },
    });

  console.log("▶ l'opérateur choisit Sienna");
  await callback("voice:sienna");
  console.log("▶ il écrit « Mon chéri Max »");
  await send({ message: { message_id: 60, date: 0, chat, from, text: "Mon chéri Max" } });
  await waitFor(() => calls.filter((c) => c.method === "sendVoice").length === 3, "3 vocaux");
  const voices = calls.filter((c) => c.method === "sendVoice");
  const markups = voices.map((v) => JSON.parse(String(v.body.reply_markup)) as { inline_keyboard: { text: string; callback_data: string }[][] });
  markups.forEach((m, i) =>
    console.log(`  vocal ${i + 1} : ${m.inline_keyboard.map((r) => r.map((b) => b.text).join(" | ")).join("  //  ")}`)
  );
  const token = markups[0].inline_keyboard[0][0].callback_data;
  await waitFor(() => kv.has(`vidsrc:${token.slice(4)}`), "source vidéo mémorisée", 5_000);

  console.log("▶ il tape 🎬 sous le vocal 1, deux fois de suite");
  await callback(token);
  await callback(token);
  const answers = calls.filter((c) => c.method === "answerCallbackQuery").slice(-2).map((c) => c.body.text);
  console.log("  réponses :", answers);
  await waitFor(() => calls.some((c) => c.method === "sendVideo"), "vidéo envoyée");
  await sleep(500);
  const videos = calls.filter((c) => c.method === "sendVideo");
  const v = videos[0];
  console.log(`  vidéos envoyées : ${videos.length} · ${v.bytes} octets · ${v.body.width}×${v.body.height} · ${v.body.duration} s · « ${v.body.caption} »`);

  console.log("▶ il change l'intensité sous le dernier vocal : le bouton 🎬 doit rester");
  const last = voices[2];
  await callback("level:2", {
    message_id: 999,
    date: 0,
    chat,
    voice: { file_id: "F", file_unique_id: "U", duration: 3 },
    reply_markup: markups[2],
  });
  const edit = calls.filter((c) => c.method === "editMessageReplyMarkup").pop();
  const rm = edit?.body.reply_markup ?? {};
  const kb = (typeof rm === "string" ? JSON.parse(rm) : rm) as { inline_keyboard?: { text: string }[][] };
  console.log(`  nouveau clavier : ${(kb.inline_keyboard ?? []).map((r) => r.map((b) => b.text).join(" | ")).join("  //  ")}`);
  void last;

  console.log("▶ un vieux bouton 🎬 (plus en mémoire)");
  await callback("vid:0000000000000000");
  console.log("  réponse :", calls.filter((c) => c.method === "answerCallbackQuery").pop()?.body.text);

  console.log("▶ /stats (admin)");
  await send({ message: { message_id: 70, date: 0, chat: { id: 8202292569, type: "private", first_name: "T" }, from: { id: 8202292569, is_bot: false, first_name: "T" }, text: "/stats", entities: [{ type: "bot_command", offset: 0, length: 6 }] } });
  await sleep(300);
  console.log("  " + String(calls.filter((c) => c.method === "sendMessage").pop()?.body.text).split("\n").slice(0, 14).join("\n  "));
  writeFileSync(process.argv[2].replace(/\.mp3$/, "-sim-ok.txt"), "ok");
  redis.close();
  telegram.close();
  process.exit(0);
}

main().catch((err) => {
  console.error("❌", err);
  process.exit(1);
});
