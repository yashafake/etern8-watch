// Внешний дозор: проверяет адреса из секрета TARGETS с GitHub и со второй точки (Vercel),
// пишет в Telegram только при смене состояния. Состояние между запусками - state.json (actions/cache).
import { readFileSync, writeFileSync, existsSync } from "node:fs";

const env = (name) => process.env[name] ?? "";
const targets = JSON.parse(env("TARGETS") || "[]"); // [{ name, url, any?: true, control?: true }]
const FAILS_TO_ALERT = 2;
const STATE_FILE = "state.json";

async function check(url) {
  try {
    const res = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(15000) });
    return res.status;
  } catch {
    return 0;
  }
}

const isUp = (t, status) => (t.any ? status > 0 : status > 0 && status < 500);

async function probeRemote(urls) {
  if (!env("PROBE_URL")) return null;
  try {
    const res = await fetch(env("PROBE_URL"), {
      method: "POST",
      headers: { "content-type": "application/json", "x-relay-key": env("PROBE_KEY") },
      body: JSON.stringify({ urls }),
      signal: AbortSignal.timeout(40000),
    });
    return res.ok ? await res.json() : null;
  } catch {
    return null;
  }
}

async function telegram(text) {
  const res = await fetch(`https://api.telegram.org/bot${env("TG_TOKEN")}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: env("TG_CHAT"), text, disable_web_page_preview: true }),
  });
  if (!res.ok) throw new Error(`telegram ${res.status}`);
}

const first = !existsSync(STATE_FILE);
const state = first ? {} : JSON.parse(readFileSync(STATE_FILE, "utf8"));
const local = await Promise.all(targets.map((t) => check(t.url)));
const remote = await probeRemote(targets.map((t) => t.url));

// Контрольные адреса (например ya.ru): если не видны ни с одной точки, пропала связь с РФ,
// а не упали наши серверы. Тогда не тревожим по каждому адресу, а пишем одно сообщение.
const upAt = (t, i) => isUp(t, local[i]) || (remote?.[t.url] !== undefined && isUp(t, remote[t.url]));
const controls = targets.map((t, i) => [t, i]).filter(([t]) => t.control);
const ruLost = controls.length > 0 && controls.every(([t, i]) => !upAt(t, i));

const changes = [];
if (ruLost !== Boolean(state.__ruLost)) {
  changes.push(ruLost ? "⚠️ Из-за рубежа не видно даже контрольных адресов РФ: похоже, пропала связь с РФ. Тревоги по сайтам приостановлены." : "✅ Связь с РФ снова есть, тревоги по сайтам включены.");
  state.__ruLost = ruLost;
}
targets.forEach((t, i) => {
  if (ruLost && !t.control) {
    console.log(`${t.name}: пропущен (нет связи с РФ)`);
    return;
  }
  const s = state[t.name] ?? { up: true, fails: 0 };
  const remoteStatus = remote?.[t.url];
  // Упавшим считаем, только если не отвечает с обеих точек (или вторая точка сама недоступна).
  const up = isUp(t, local[i]) || (remoteStatus !== undefined && isUp(t, remoteStatus));
  s.fails = up ? 0 : s.fails + 1;
  if (up && !s.up) {
    changes.push(`✅ ${t.name} снова отвечает (${local[i] || remoteStatus})`);
    s.up = true;
  } else if (!up && s.up && s.fails >= FAILS_TO_ALERT) {
    changes.push(`🔴 ${t.name} не отвечает ${s.fails} проверки подряд (GitHub ${local[i]}, Vercel ${remoteStatus ?? "нет связи"})`);
    s.up = false;
  }
  state[t.name] = s;
  console.log(`${t.name}: github=${local[i]} vercel=${remoteStatus ?? "-"} up=${up} fails=${s.fails}`);
});

if (first) {
  const down = targets.filter((t, i) => !t.control && !upAt(t, i));
  for (const t of down) state[t.name] = { up: false, fails: FAILS_TO_ALERT };
  await telegram(
    `Дозор etern8-watch запущен, ${targets.length} адресов, раз в 5 минут.\n` +
      (down.length ? `Сейчас не отвечают: ${down.map((t) => t.name).join(", ")}` : "Сейчас всё отвечает."),
  );
} else if (changes.length) {
  await telegram(changes.join("\n"));
}
writeFileSync(STATE_FILE, JSON.stringify(state));
