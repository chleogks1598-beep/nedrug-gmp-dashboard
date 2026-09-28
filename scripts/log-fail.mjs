// 스케줄러 진입점(run-local-update.cmd / run-change-orders.cmd)이 단계 결과를 남길 때 쓰는 도구.
//
//   node scripts/log-fail.mjs <stage> <exitCode>   단계 실패 — 로그에 "!!" 줄 + 연속 실패 +1
//   node scripts/log-fail.mjs ok <stage>           단계 성공 — 연속 실패 카운터 리셋
//
// .cmd 는 CP949 로 읽히므로 한글을 직접 넣을 수 없다. 그래서 문구만 이 파일(UTF-8)로 뺐다.
// 이게 없으면 단계가 죽어도 local-update.log 에는 '정상 종료' 없이 뚝 끊긴 흔적만 남아,
// 나중에 로그만 봐서는 '멈춰 있는 중'인지 '죽은 것'인지 구별할 수 없다(2026-09-04 실제 오진).
//
// 연속 실패 알림(2026-09-28 추가): 같은 단계가 STREAK_ALERT 회 연속 실패하면 이 PC에
// Windows 알림을 띄운다. 2026-09-17~28 에 git 충돌로 11일 동안 매 회차 실패했는데,
// 로그에만 남고 아무도 몰랐다. 메일(GitHub)은 git 이 고장 나면 못 보내므로 로컬 알림으로 한다.
// 계속 실패하면 REPEAT_EVERY 회마다 다시 띄운다(2시간 주기면 약 12시간마다).
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const LOG = path.join(ROOT, "local-update.log");
const STREAK = path.join(ROOT, ".fail-streak.json");
const STREAK_ALERT = 3;
const REPEAT_EVERY = 6;
const stamp = () => new Date().toISOString().replace("T", " ").slice(0, 19); // 이 로그는 UTC 기준

const STAGE = { gmp: "GMP 실사결과", safety: "회수·폐기/행정처분", "change-orders": "변경명령" };
const name = key => STAGE[key] ?? key ?? "알 수 없는";

const readStreak = () => { try { return JSON.parse(fs.readFileSync(STREAK, "utf8")); } catch { return {}; } };
const writeStreak = s => { try { fs.writeFileSync(STREAK, JSON.stringify(s, null, 2) + "\n"); } catch {} };

// PowerShell 로 Windows 토스트를 띄운다. 한글이 깨지지 않게 -EncodedCommand(UTF-16LE)로 넘긴다.
function toast(title, body) {
  const q = s => "'" + String(s).replace(/'/g, "''").replace(/[<>&]/g, c => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" }[c])) + "'";
  const ps = `
[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] | Out-Null
$x = New-Object Windows.Data.Xml.Dom.XmlDocument
$x.LoadXml('<toast scenario="reminder"><visual><binding template="ToastGeneric"><text>' + ${q(title)} + '</text><text>' + ${q(body)} + '</text></binding></visual><actions><action content="확인" arguments="dismiss" activationType="system"/></actions></toast>')
$app = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe'
[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($app).Show([Windows.UI.Notifications.ToastNotification]::new($x))`;
  try {
    execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(ps, "utf16le").toString("base64")],
      { stdio: "ignore", timeout: 30000 });
    return true;
  } catch { return false; }
}

const append = line => { try { fs.appendFileSync(LOG, line + "\n"); } catch {} console.log(line); };

if (process.argv[2] === "ok") {
  const key = process.argv[3];
  const s = readStreak();
  if (s[key]?.count) {
    append(`[${stamp()}] ${name(key)} 단계 복구됨 — 직전까지 ${s[key].count}회 연속 실패했었다.`);
    delete s[key];
    writeStreak(s);
  }
  process.exit(0);
}

const key = process.argv[2];
const code = process.argv[3] ?? "?";
append(
  `[${stamp()}] !! ${name(key)} 단계 비정상 종료 (종료코드 ${code}). ` +
  `바로 위 줄이 멈춘 지점이다. 종료코드 -1073741510(0xC000013A)이면 창을 닫았거나 Ctrl+C 로 끊긴 것.`);

const s = readStreak();
const cur = s[key] ?? { count: 0, since: new Date().toISOString() };
cur.count++;
s[key] = cur;
writeStreak(s);

if (cur.count >= STREAK_ALERT && (cur.count - STREAK_ALERT) % REPEAT_EVERY === 0) {
  const shown = toast(
    `식약처 대시보드 갱신 ${cur.count}회 연속 실패`,
    `${name(key)} 단계가 ${cur.since.slice(0, 10)}부터 계속 실패 중입니다. ` +
    `C:\\Users\\han1598\\projects\\nedrug-gmp\\local-update.log 의 "!!" 줄을 확인하세요.`);
  append(`[${stamp()}] !! ${name(key)} ${cur.count}회 연속 실패 — Windows 알림 ${shown ? "표시" : "표시 실패"}`);
}
