require("dotenv").config();
const fs = require("fs");
const { Client } = require("pg");

const u = new URL(process.env.DATABASE_URL);
const ref = u.hostname.replace(/^db\./, "").replace(/\.supabase\.co$/, "").replace(/^postgres\./, "") || u.username.split(".")[1];
const pass = decodeURIComponent(u.password);
const user = "postgres." + ref;
const regions = ["ap-southeast-1","ap-southeast-2","ap-northeast-1","ap-northeast-2","ap-south-1",
  "us-east-1","us-east-2","us-west-1","us-west-2","ca-central-1","sa-east-1",
  "eu-west-1","eu-west-2","eu-west-3","eu-central-1","eu-central-2","eu-north-1"];

if (!pass || /YOUR-PASSWORD|\[|\]/.test(pass)) {
  console.log("Mật khẩu trong .env chưa đúng (còn chữ [YOUR-PASSWORD]?). Hãy điền mật khẩu database thật vào .env rồi chạy lại.");
  process.exit(1);
}
console.log("Mã project:", ref, "| đang dò", regions.length * 2, "địa chỉ pooler...");

async function tryHost(host) {
  const c = new Client({ host, port: 5432, user, password: pass, database: "postgres",
    ssl: { rejectUnauthorized: false }, connectionTimeoutMillis: 8000 });
  try { await c.connect(); await c.end(); return { host, status: "ok" }; }
  catch (e) {
    const m = String(e.message);
    if (/password authentication failed/i.test(m)) return { host, status: "badpass" };
    return { host, status: "no", msg: m };
  }
}

(async () => {
  const hosts = [];
  for (const r of regions) for (const p of ["aws-0", "aws-1"]) hosts.push(`${p}-${r}.pooler.supabase.com`);
  const results = await Promise.all(hosts.map(tryHost));
  const ok = results.find((r) => r.status === "ok");
  const bad = results.find((r) => r.status === "badpass");
  if (ok) {
    const line = `DATABASE_URL=postgresql://${user}:${encodeURIComponent(pass)}@${ok.host}:5432/postgres`;
    let env = fs.readFileSync(".env", "utf8");
    env = /^DATABASE_URL=.*$/m.test(env) ? env.replace(/^DATABASE_URL=.*$/m, () => line) : env + "\n" + line + "\n";
    fs.writeFileSync(".env", env);
    console.log("\n✅ TÌM THẤY:", ok.host, "\nĐã tự cập nhật DATABASE_URL trong .env. Giờ chạy: npm start");
  } else if (bad) {
    console.log("\n⚠️ Đúng vùng máy chủ (" + bad.host + ") nhưng SAI MẬT KHẨU database.\nVào Supabase → Project Settings → Database → Reset database password, đặt mật khẩu chỉ gồm chữ và số, điền vào .env rồi chạy lại.");
  } else {
    console.log("\n❌ Không kết nối được tới địa chỉ nào. Ví dụ lỗi:", results[0].msg);
    console.log("Có thể mạng đang chặn: thử phát wifi từ điện thoại (4G) hoặc bật VPN rồi chạy lại.");
  }
})();