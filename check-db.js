require("dotenv").config();
const net = require("net"), { Client } = require("pg");
const u = process.env.DATABASE_URL || "";
let url;
try { url = new URL(u); } catch (e) { console.log("DATABASE_URL trống hoặc sai định dạng (mật khẩu có ký tự đặc biệt?)"); process.exit(1); }
const port = Number(url.port || 5432);
console.log("user:", url.username, "| host:", url.hostname, "| cổng:", port);
if (/^db\..*\.supabase\.co$/.test(url.hostname)) console.log("=> SAI: đây là Direct connection (IPv6). Phải dùng host Pooler.");
if (url.hostname.includes("pooler") && !url.username.includes(".")) console.log("=> SAI: với Pooler, user phải dạng postgres.<mã project>");
const s = net.connect({ host: url.hostname, port, timeout: 8000 });
s.on("connect", () => { console.log("TCP: THÔNG"); s.destroy(); dbTest(); });
s.on("timeout", () => { console.log("TCP: TIMEOUT (mạng chặn cổng này)"); process.exit(); });
s.on("error", (e) => { console.log("TCP lỗi:", e.code); process.exit(); });
async function dbTest() {
  const c = new Client({ connectionString: u, ssl: { rejectUnauthorized: false } });
  try { await c.connect(); console.log("DB: KẾT NỐI OK"); await c.end(); }
  catch (e) { console.log("DB lỗi:", e.message); }
  process.exit();
}
