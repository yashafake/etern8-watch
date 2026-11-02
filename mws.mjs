// MWS API от сервисного аккаунта sa-failover (роль compute.editor), ключ ak-failover (ES256).
// Схема из открытого go-sdk mws-cloud-platform: JWT с kid=имя ключа -> IAM-токен -> Bearer к compute.
import { createSign } from "node:crypto";
import { execFileSync } from "node:child_process";

const PROJECT = "project-radchenko-yakov";
const SA = `projects/${PROJECT}/serviceAccounts/sa-failover`;
const VM = `/compute/v1/projects/${PROJECT}/virtualMachines/vm-kanwoy`;
const b64u = (b) => Buffer.from(b).toString("base64url");

async function token() {
  const now = Math.floor(Date.now() / 1000);
  const head = b64u(JSON.stringify({ alg: "ES256", typ: "JWT", kid: "ak-failover" }));
  const body = b64u(JSON.stringify({ sub: SA, iat: now, exp: now + 3600 }));
  const sig = createSign("SHA256").update(`${head}.${body}`)
    .sign({ key: process.env.MWS_SA_KEY, dsaEncoding: "ieee-p1363" });
  const res = await fetch(
    `https://iam.mwsapis.ru/iam/v2/tokens/:issueServiceAccountToken?serviceAccount=${encodeURIComponent(SA)}`,
    { headers: { Authorization: `${head}.${body}.${b64u(sig)}` } },
  );
  if (!res.ok) throw new Error(`MWS IAM ${res.status} ${await res.text()}`);
  const j = await res.json();
  return typeof j.accessToken === "object" ? j.accessToken.value : j.accessToken;
}

async function api(method, path, body) {
  const res = await fetch(`https://compute.mwsapis.ru${path}`, {
    method,
    headers: { Authorization: `Bearer ${await token()}`, "content-type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`MWS ${method} ${path} ${res.status} ${(await res.text()).slice(0, 300)}`);
  return res.json();
}

export const getVm = () => api("GET", VM);
export const powerOf = (vm) => vm?.status?.hardware?.power ?? "UNKNOWN";

// Включить/выключить ВМ: тот же spec с другим hardware.power (не проверено на боевой ВМ, проверить на учениях)
export async function setPower(power) {
  const vm = await getVm();
  if (powerOf(vm) === power) return `уже ${power}`;
  vm.spec.hardware.power = power;
  await api("POST", `${VM}?updateOnly=true`, { metadata: vm.metadata, spec: vm.spec });
  return `запрошено ${power}`;
}

// Команда на MWS через ограниченный ключ (failover-gate пускает только failover-ctl из списка)
export function gate(cmd, timeoutMs = 30000) {
  return execFileSync("ssh", [
    "-i", "gate_key", "-o", "UserKnownHostsFile=known_hosts", "-o", "StrictHostKeyChecking=yes",
    "-o", "BatchMode=yes", "-o", "ConnectTimeout=15", "root@111.88.129.31", cmd,
  ], { encoding: "utf8", timeout: timeoutMs });
}

export function mwsStatus() {
  try {
    const out = gate("status");
    const kv = Object.fromEntries(out.split("\n").filter((l) => l.includes("=")).map((l) => {
      const i = l.indexOf("="); return [l.slice(0, i), l.slice(i + 1)];
    }));
    return { reachable: true, mode: kv.mode?.split(" ")[0], since: kv.mode?.match(/since=(\S+)/)?.[1], raw: out };
  } catch {
    return { reachable: false, mode: "standby" };  // ВМ на паузе или недоступна
  }
}
