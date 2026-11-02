// Действие по кнопке из Telegram (workflow act.yml, вход CMD = up | down | status).
import { getVm, powerOf, setPower, gate, mwsStatus } from "./mws.mjs";

const env = (n) => process.env[n] ?? "";
async function telegram(text) {
  await fetch(`https://api.telegram.org/bot${env("TG_TOKEN")}/sendMessage`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: env("TG_CHAT"), text }),
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const cmd = env("CMD");
try {
  if (cmd === "up") {
    const power = powerOf(await getVm());
    if (power !== "ON") {
      await telegram(`Включаю MWS (было ${power})...`);
      await setPower("ON");
    }
    let st = mwsStatus();
    for (let i = 0; i < 24 && !st.reachable; i++) { await sleep(15000); st = mwsStatus(); }
    if (!st.reachable) throw new Error("MWS не отвечает по SSH 6 минут после включения");
    console.log(gate("up"));   // дальше failover-ctl сам пишет в Telegram о каждом шаге
  } else if (cmd === "down") {
    console.log(gate("down"));
  } else if (cmd === "status") {   // проверка цепочки: MWS API (питание ВМ) + вход по ключу дозора
    const power = powerOf(await getVm());
    const st = mwsStatus();
    const text = `Проверка цепочки дозора: ВМ MWS ${power}, вход по ключу ${st.reachable ? "есть" : "НЕТ"}.\n${st.reachable ? st.raw.trim() : ""}`;
    console.log(text);
    await telegram(text.slice(0, 3500));
    if (power === "UNKNOWN" || !st.reachable) process.exit(1);
  } else {
    throw new Error(`неизвестная команда ${cmd}`);
  }
} catch (e) {
  console.error(e);
  await telegram(`Не получилось (${cmd}): ${String(e.message).slice(0, 300)}`);
  process.exit(1);
}
