// Внешний дозор: проверяет адреса из секрета TARGETS с GitHub и со второй точки (Vercel),
// пишет в Telegram только при смене состояния. Состояние между запусками - state.json (actions/cache).
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { mwsStatus, gate, setPower } from "./mws.mjs";
import { connect } from "node:net";
import { request as httpsRequest } from "node:https";

const env = (name) => process.env[name] ?? "";
const targets = JSON.parse(env("TARGETS") || "[]"); // [{ name, url, any?: true, control?: true }]
// Основной сервер с 05.11.2026 - FirstVDS. Проверяется ответ ПРИЛОЖЕНИЯ (https IWANT с привязкой к IP), а не nginx:
// http://IP отвечает 301 даже при мёртвых приложениях. По домену нельзя: при переключении домены уходят на MWS.
// Только с GitHub (вторая точка Vercel не умеет привязку к IP); решение всё равно за кнопкой и main_alive на MWS.
const PRIMARY = { name: "FirstVDS: основной сервер", url: "https://iwantconcept.store/", ip: "168.113.188.12", localOnly: true };
if (!targets.some((t) => t.name === PRIMARY.name)) targets.push(PRIMARY);
const MWS_TARGET = "MWS резерв";   // пока MWS в ожидании (на паузе), его недоступность - не тревога
const FAILS_TO_ALERT = 2;
const STATE_FILE = "state.json";

// https на заданный IP с SNI и Host домена (как curl --resolve)
function checkVia(url, ip) {
  return new Promise((resolve) => {
    const u = new URL(url);
    const req = httpsRequest({ host: ip, servername: u.hostname, headers: { host: u.hostname }, path: u.pathname, method: "GET", timeout: 15000 },
      (res) => { res.resume(); resolve(res.statusCode ?? 0); });
    req.on("timeout", () => { req.destroy(); resolve(0); });
    req.on("error", () => resolve(0));
    req.end();
  });
}

async function check(url, ip) {
  if (ip) return checkVia(url, ip);
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

async function telegram(text, buttons) {
  const reply_markup = buttons ? { inline_keyboard: [buttons.map(([t, d]) => ({ text: t, callback_data: d }))] } : undefined;
  const res = await fetch(`https://api.telegram.org/bot${env("TG_TOKEN")}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: env("TG_CHAT"), text, disable_web_page_preview: true, reply_markup }),
  });
  if (!res.ok) throw new Error(`telegram ${res.status}`);
}

const first = !existsSync(STATE_FILE);
const state = first ? {} : JSON.parse(readFileSync(STATE_FILE, "utf8"));

// Нажатия кнопок забираем сами (getUpdates при каждом запуске): реакция 5-15 минут, зато без токена GitHub
// в Vercel. Мгновенный вариант - вебхук etern8-tg-relay/api/tg-hook, включить, когда будет токен GitHub.
const LABELS = { "fo:up": "Переключаю на MWS", "fo:down": "Возвращаю на FirstVDS", "fo:wait": "Жду, ничего не делаю" };
async function tgApi(method, body) {
  const res = await fetch(`https://api.telegram.org/bot${env("TG_TOKEN")}/${method}`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });
  return res.json().catch(() => ({}));
}
async function pollButtons() {
  if (!env("TG_TOKEN")) return;
  const r = await tgApi("getUpdates", { offset: state.__tgOffset || 0, timeout: 0, allowed_updates: ["callback_query"] });
  for (const u of r.result ?? []) try {
    state.__tgOffset = u.update_id + 1;
    writeFileSync(STATE_FILE, JSON.stringify(state));   // каждое нажатие обрабатывается не больше одного раза
    const cq = u.callback_query;
    if (!cq) continue;
    if (String(cq.from?.id) !== env("TG_CHAT") || !LABELS[cq.data]) {
      await tgApi("answerCallbackQuery", { callback_query_id: cq.id, text: "Нет доступа" });
      continue;
    }
    // Кнопка из сообщения старше 30 минут не исполняется: обстановка могла смениться
    if (Date.now() / 1000 - (cq.message?.date ?? 0) > 30 * 60) {
      await tgApi("editMessageReplyMarkup", { chat_id: cq.message.chat.id, message_id: cq.message.message_id, reply_markup: { inline_keyboard: [] } });
      await tgApi("answerCallbackQuery", { callback_query_id: cq.id, text: "Кнопка устарела, дождись нового сообщения" });
      continue;
    }
    await tgApi("editMessageReplyMarkup", { chat_id: cq.message.chat.id, message_id: cq.message.message_id, reply_markup: { inline_keyboard: [] } });
    let note = LABELS[cq.data];
    if (cq.data !== "fo:wait") {
      const res = await fetch(`https://api.github.com/repos/${env("GITHUB_REPOSITORY")}/actions/workflows/act.yml/dispatches`, {
        method: "POST",
        headers: { Authorization: `Bearer ${env("GITHUB_TOKEN")}`, Accept: "application/vnd.github+json", "content-type": "application/json" },
        body: JSON.stringify({ ref: "main", inputs: { cmd: cq.data.slice(3) } }),
      });
      if (!res.ok) note = `Не удалось запустить (${res.status})`;
    }
    await tgApi("answerCallbackQuery", { callback_query_id: cq.id, text: note });
    await tgApi("sendMessage", { chat_id: cq.message.chat.id, text: `Принято: ${note}`, reply_to_message_id: cq.message.message_id });
    console.log(`кнопка ${cq.data}: ${note}`);
  } catch (e) {
    console.error("кнопка:", e);   // сбой одного нажатия не роняет весь запуск дозора
  }
}
await pollButtons();
// ---- Почта Beget (02.11 лежит вместе с VPS): от неё зависят ящики доменов etern8 и рассылка.
// Проверяем, принимает ли сервер подключения (SMTP 465, IMAP 993); пишем только при смене состояния.
function tcpOpen(host, port, ms = 7000) {
  return new Promise((resolve) => {
    const sock = connect({ host, port });
    const done = (ok) => { sock.destroy(); resolve(ok); };
    sock.setTimeout(ms, () => done(false));
    sock.once("connect", () => done(true));
    sock.once("error", () => done(false));
  });
}
try {
  const ports = [["smtp.beget.com", 465], ["imap.beget.com", 993]];
  const res = [];
  for (const [h, p] of ports) res.push((await tcpOpen(h, p)) || (await tcpOpen(h, p)));
  const mailUp = res.every(Boolean);
  if (state.__begetMail === undefined) state.__begetMail = mailUp;
  else if (mailUp !== state.__begetMail) {
    state.__begetMail = mailUp;
    await telegram(mailUp
      ? "📬 Почта Beget снова принимает подключения (SMTP 465, IMAP 993). Можно возвращать ящики и рассылку: напиши Claude."
      : "📪 Почта Beget снова не отвечает (SMTP 465 / IMAP 993).");
  }
  console.log("почта Beget:", ports.map(([h, p], i) => `${h}:${p}=${res[i] ? "ok" : "нет"}`).join(" "));
} catch (e) {
  console.error("проверка почты Beget:", e);
}

writeFileSync(STATE_FILE, JSON.stringify(state));   // смещение Telegram не должно потеряться при сбое ниже
const local = await Promise.all(targets.map((t) => check(t.url, t.ip)));
const remoteAll = await probeRemote(targets.filter((t) => !t.localOnly).map((t) => t.url));
// цель с привязкой к IP вторая точка не проверяет: её ответ по тому же URL пришёл бы через DNS (с MWS)
const remote = remoteAll && Object.fromEntries(targets.filter((t) => !t.localOnly && remoteAll[t.url] !== undefined).map((t) => [t.url, remoteAll[t.url]]));

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
  if (t.name === MWS_TARGET && state.__foMode !== "active") {
    state[t.name] = { up: true, fails: 0 };
    console.log(`${t.name}: пропущен (MWS в ожидании: ${state.__foMode ?? "?"})`);
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
// ---- Переключение FirstVDS <-> MWS: кнопки и автопауза. Режим берётся с самой MWS (failover-ctl status).
const VPS = PRIMARY.name;
const HOUR = 3600_000;
const now = Date.now();
const vps = state[VPS];
if (env("MWS_GATE") && vps && !ruLost) try {
  const fo = mwsStatus();
  // недоступна MWS: на паузе (была standby/returned) или упала, обслуживая сайты (active и т.п.) - тогда режим не терять
  if (!fo.reachable && state.__foMode && !["standby", "returned"].includes(state.__foMode)) fo.mode = state.__foMode;
  console.log(`MWS: reachable=${fo.reachable} mode=${fo.mode} since=${fo.since ?? "-"}`);
  if (!fo.reachable && fo.mode === "active" && now - (state.__mwsLost || 0) > HOUR) {
    await telegram("🔴 Сайты на MWS (режим active), а MWS не отвечает по SSH. Проверь MWS в панели MWS Cloud.");
    state.__mwsLost = now;
  }
  state.__foMode = fo.mode;
  // переключение зависло (процесс убит, ВМ перезагрузилась): switching/returning дольше 30 минут
  if (fo.reachable && ["switching", "returning"].includes(fo.mode) && fo.since && now - Date.parse(fo.since) > 30 * 60_000
      && now - (state.__foStuck || 0) > 3 * HOUR) {
    await telegram(`⚠️ MWS в режиме ${fo.mode} больше 30 минут: переключение, похоже, оборвалось. Посмотреть: failover-ctl status и /var/log/failover.log на MWS; сбросить: failover-ctl reset-mode.`);
    state.__foStuck = now;
  }
  if (vps.up) state.__offeredUp = 0;
  if (!vps.up) state.__offeredDown = 0;

  // switching/returning - переключение уже идёт; active - сайты уже на MWS
  if (!vps.up && ["standby", "returned"].includes(fo.mode) && now - (state.__offeredUp || 0) > HOUR) {
    await telegram("🔴 FirstVDS (основной сервер) не отвечает. Переключить сайты на резервный MWS? Данные будут из последнего ночного снимка FirstVDS, MWS включится из паузы сам (до 6 минут).",
      [["Переключить на MWS", "fo:up"], ["Ждать", "fo:wait"]]);
    state.__offeredUp = now;
  }
  if (vps.up && fo.mode === "active" && now - (state.__offeredDown || 0) > 6 * HOUR) {
    await telegram("✅ FirstVDS снова отвечает, а сайты на MWS. Вернуть на FirstVDS? Базы MWS переедут на FirstVDS, прежние базы FirstVDS сохранятся рядом.",
      [["Вернуть на FirstVDS", "fo:down"], ["Пока нет", "fo:wait"]]);
    state.__offeredDown = now;
  }
  // Автопауза: через 2 ч после возврата, если на MWS нет новых заказов/заявок и почти нет посетителей
  if (fo.mode === "returned" && fo.since && now - Date.parse(fo.since) > 2 * HOUR) {
    const delta = gate("delta").trim();
    const visits = parseInt(gate("visits"), 10) || 0;
    console.log(`автопауза: delta=[${delta}] visits=${visits}`);
    if (!delta && visits < 50) {
      gate("standby");
      const r = await setPower("OFF");
      await telegram(`MWS поставлен на паузу (${r}): после возврата новых заказов и заявок на нём нет, посетителей за 30 мин ${visits}.`);
    } else if (now - (state.__pauseHeld || 0) > 6 * HOUR) {
      await telegram(`MWS пока не ставлю на паузу. Посетителей за 30 мин: ${visits}. Новое на MWS после возврата:\n${delta || "нет"}\nЕсли там заказы или заявки - их надо перенести на FirstVDS руками.`);
      state.__pauseHeld = now;
    }
  }
} catch (e) {
  console.error("блок переключения:", e);
  if (now - (state.__foErr || 0) > 6 * HOUR) {
    await telegram(`Дозор: ошибка в блоке переключения: ${String(e.message).slice(0, 200)}`);
    state.__foErr = now;
  }
}

writeFileSync(STATE_FILE, JSON.stringify(state));
