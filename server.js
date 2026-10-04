require("dotenv").config();
const path = require("path");
const crypto = require("crypto");
const express = require("express");
const session = require("express-session");
const pgSession = require("connect-pg-simple")(session);
const { Pool } = require("pg");
const bcrypt = require("bcryptjs");
const ExcelJS = require("exceljs");
const {
  Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell,
  WidthType, AlignmentType, ShadingType
} = require("docx");

const app = express();
const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, "public");
const DB_URL = process.env.DATABASE_URL || "";

if (!DB_URL) console.error("⚠️  Thiếu biến môi trường DATABASE_URL (chuỗi kết nối Supabase).");
if (!process.env.SESSION_SECRET) console.warn("⚠️  Chưa đặt SESSION_SECRET, đang dùng khóa tạm. Hãy đặt biến này.");

const pool = new Pool({
  connectionString: DB_URL,
  ssl: /localhost|127\.0\.0\.1/.test(DB_URL) ? false : { rejectUnauthorized: false },
  max: 3,
  idleTimeoutMillis: 10000,
  connectionTimeoutMillis: 10000
});
pool.on("error", (e) => console.error("pg pool error:", e.message));

const ROLES = ["ADMIN", "CLASS_LEADER", "CLASS_VICE", "TEAM_LEADER"];
const RATINGS = ["Tốt", "Khá", "Trung bình", "Yếu"];

/* ---------------------------------------------------------------- helpers */
const h = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const q = async (text, params = []) => (await pool.query(text, params)).rows;
const one = async (text, params = []) => (await pool.query(text, params)).rows[0] || null;
const ok = (res, data = {}) => res.json({ ok: true, ...data });
const fail = (res, code, message) => res.status(code).json({ ok: false, error: message });
const str = (v) => String(v == null ? "" : v).trim();
const normalizeId = (v) => {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : null;
};
// Tổ trưởng chỉ thấy tổ của mình (nếu chưa gán tổ thì không thấy gì)
const teamFilter = (user) => (user.role === "TEAM_LEADER" ? user.team_id || -1 : null);

/* ----------------------------------------------------------------- schema */
const SCHEMA = `
CREATE TABLE IF NOT EXISTS teams(
  id SERIAL PRIMARY KEY,
  name TEXT UNIQUE NOT NULL
);
CREATE TABLE IF NOT EXISTS users(
  id SERIAL PRIMARY KEY,
  username TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  full_name TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('ADMIN','CLASS_LEADER','CLASS_VICE','TEAM_LEADER')),
  team_id INTEGER REFERENCES teams(id) ON DELETE SET NULL,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS students(
  id SERIAL PRIMARY KEY,
  student_code TEXT UNIQUE NOT NULL,
  full_name TEXT NOT NULL,
  gender TEXT,
  team_id INTEGER REFERENCES teams(id) ON DELETE SET NULL,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS months(
  id SERIAL PRIMARY KEY,
  month INTEGER NOT NULL CHECK(month BETWEEN 1 AND 12),
  year INTEGER NOT NULL,
  UNIQUE(month,year)
);
CREATE TABLE IF NOT EXISTS score_rules(
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  type TEXT NOT NULL CHECK(type IN ('PLUS','MINUS')),
  points INTEGER NOT NULL CHECK(points > 0),
  description TEXT
);
CREATE TABLE IF NOT EXISTS score_records(
  id SERIAL PRIMARY KEY,
  student_id INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  month_id INTEGER NOT NULL REFERENCES months(id) ON DELETE CASCADE,
  rule_id INTEGER REFERENCES score_rules(id) ON DELETE SET NULL,
  points INTEGER NOT NULL,
  description TEXT,
  recorded_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS classifications(
  id SERIAL PRIMARY KEY,
  min_score INTEGER NOT NULL,
  max_score INTEGER NOT NULL,
  name TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS conduct_records(
  id SERIAL PRIMARY KEY,
  student_id INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  month_id INTEGER NOT NULL REFERENCES months(id) ON DELETE CASCADE,
  rating TEXT NOT NULL CHECK(rating IN ('Tốt','Khá','Trung bình','Yếu')),
  note TEXT,
  recorded_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS settings(
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS user_sessions(
  sid VARCHAR NOT NULL PRIMARY KEY,
  sess JSON NOT NULL,
  expire TIMESTAMP(6) NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_session_expire ON user_sessions(expire);
CREATE INDEX IF NOT EXISTS idx_scores_month_student ON score_records(month_id, student_id);
CREATE INDEX IF NOT EXISTS idx_conduct_month_student ON conduct_records(month_id, student_id);

-- Bật RLS (không tạo policy) để người ngoài không đọc được dữ liệu qua Supabase Data API.
-- Server kết nối bằng tài khoản postgres nên không bị ảnh hưởng.
ALTER TABLE teams ENABLE ROW LEVEL SECURITY;
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE students ENABLE ROW LEVEL SECURITY;
ALTER TABLE months ENABLE ROW LEVEL SECURITY;
ALTER TABLE score_rules ENABLE ROW LEVEL SECURITY;
ALTER TABLE score_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE classifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE conduct_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_sessions ENABLE ROW LEVEL SECURITY;
`;

async function seedDefaults(c) {
  const cq = async (t, p = []) => (await c.query(t, p)).rows;
  const cone = async (t, p = []) => (await cq(t, p))[0] || null;

  if (!(await cone("SELECT id FROM teams LIMIT 1"))) {
    for (let i = 1; i <= 4; i++) await cq("INSERT INTO teams(name) VALUES($1) ON CONFLICT(name) DO NOTHING", [`Tổ ${i}`]);
  }
  if (!(await cone("SELECT id FROM score_rules LIMIT 1"))) {
    const rules = [
      ["Phát biểu xây dựng bài", "PLUS", 2, "Có phát biểu xây dựng bài"],
      ["Giúp đỡ bạn", "PLUS", 2, "Hỗ trợ bạn học"],
      ["Hoàn thành tốt nhiệm vụ", "PLUS", 3, "Hoàn thành tốt nhiệm vụ được giao"],
      ["Đi học muộn", "MINUS", 2, "Đi học muộn"],
      ["Không làm bài tập", "MINUS", 3, "Không hoàn thành bài tập"],
      ["Không đồng phục", "MINUS", 2, "Không đúng đồng phục"],
      ["Vi phạm nội quy", "MINUS", 5, "Vi phạm nội quy lớp"]
    ];
    for (const r of rules) await cq("INSERT INTO score_rules(name,type,points,description) VALUES($1,$2,$3,$4)", r);
  }
  if (!(await cone("SELECT id FROM classifications LIMIT 1"))) {
    for (const r of [[90, 999, "Tốt"], [80, 89, "Khá"], [65, 79, "Trung bình"], [-999, 64, "Yếu"]])
      await cq("INSERT INTO classifications(min_score,max_score,name) VALUES($1,$2,$3)", r);
  }
  await cq("INSERT INTO settings(key,value) VALUES('base_score','100') ON CONFLICT(key) DO NOTHING");

  if (!(await cone("SELECT id FROM users LIMIT 1"))) {
    const username = str(process.env.ADMIN_USERNAME) || "admin";
    const password = process.env.ADMIN_PASSWORD || "admin123";
    await cq("INSERT INTO users(username,password_hash,full_name,role) VALUES($1,$2,$3,'ADMIN')",
      [username, bcrypt.hashSync(password, 10), "Quản trị viên"]);
  }

  if (String(process.env.SEED_DEMO || "").toLowerCase() === "true" && !(await cone("SELECT id FROM students LIMIT 1"))) {
    const teams = await cq("SELECT id FROM teams ORDER BY id");
    const names = [
      ["HS001", "Nguyễn Minh Anh", "Nữ"], ["HS002", "Trần Quốc Bảo", "Nam"],
      ["HS003", "Lê Hoàng Nam", "Nam"], ["HS004", "Phạm Ngọc Mai", "Nữ"],
      ["HS005", "Võ Thành Đạt", "Nam"], ["HS006", "Đỗ Khánh Linh", "Nữ"],
      ["HS007", "Nguyễn Gia Huy", "Nam"], ["HS008", "Trương Hà My", "Nữ"],
      ["HS009", "Bùi Đức Long", "Nam"], ["HS010", "Hoàng Yến Nhi", "Nữ"],
      ["HS011", "Phan Nhật Minh", "Nam"], ["HS012", "Lâm Thảo Vy", "Nữ"]
    ];
    for (let i = 0; i < names.length; i++)
      await cq("INSERT INTO students(student_code,full_name,gender,team_id) VALUES($1,$2,$3,$4)",
        [...names[i], teams[i % teams.length].id]);
    const { month, year } = vnYearMonth();
    const mo = await cone("INSERT INTO months(month,year) VALUES($1,$2) ON CONFLICT(month,year) DO UPDATE SET month=EXCLUDED.month RETURNING *", [month, year]);
    const admin = await cone("SELECT id FROM users WHERE role='ADMIN' ORDER BY id LIMIT 1");
    const plus = await cq("SELECT * FROM score_rules WHERE type='PLUS' ORDER BY id");
    const minus = await cq("SELECT * FROM score_rules WHERE type='MINUS' ORDER BY id");
    const students = await cq("SELECT id FROM students ORDER BY id");
    for (let i = 0; i < students.length; i++) {
      if (i % 2 === 0) {
        const r = plus[i % plus.length];
        await cq("INSERT INTO score_records(student_id,month_id,rule_id,points,description,recorded_by) VALUES($1,$2,$3,$4,$5,$6)",
          [students[i].id, mo.id, r.id, r.points, r.name + " (mẫu)", admin.id]);
      }
      if (i % 3 === 0) {
        const r = minus[i % minus.length];
        await cq("INSERT INTO score_records(student_id,month_id,rule_id,points,description,recorded_by) VALUES($1,$2,$3,$4,$5,$6)",
          [students[i].id, mo.id, r.id, -r.points, r.name + " (mẫu)", admin.id]);
        await cq("INSERT INTO conduct_records(student_id,month_id,rating,note,recorded_by) VALUES($1,$2,'Khá',$3,$4)",
          [students[i].id, mo.id, "Có vi phạm trong tháng", admin.id]);
      }
    }
  }
}

async function initDb() {
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    await c.query("SELECT pg_advisory_xact_lock(86420531)");
    const t = (await c.query(
      "SELECT to_regclass('public.users') AS a, to_regclass('public.settings') AS b, to_regclass('public.user_sessions') AS c, to_regclass('public.teams') AS d"
    )).rows[0];
    if (!t.a || !t.b || !t.c || !t.d) await c.query(SCHEMA);
    await seedDefaults(c);
    await c.query("DELETE FROM user_sessions WHERE expire < NOW()");
    await c.query("COMMIT");
  } catch (e) {
    await c.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    c.release();
  }
}

let initPromise = null;
function ensureDb() {
  if (!initPromise) {
    initPromise = initDb().catch((err) => {
      console.error("Khởi tạo database thất bại:", err);
      initPromise = null;
      throw err;
    });
  }
  return initPromise;
}

/* ------------------------------------------------------------- middleware */
app.set("trust proxy", 1); // bắt buộc trên Vercel để cookie secure hoạt động
app.disable("x-powered-by");
app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(PUBLIC_DIR, { index: false, maxAge: "5m" }));

// Phải khởi tạo DB trước session (session cần bảng user_sessions)
app.use(async (req, res, next) => {
  try {
    await ensureDb();
    next();
  } catch (e) {
    if (req.path.startsWith("/api/")) return fail(res, 503, "Không kết nối được database Supabase. Kiểm tra DATABASE_URL.");
    res.status(503).send("Không kết nối được database Supabase. Kiểm tra biến DATABASE_URL trên Vercel.");
  }
});

app.use(session({
  store: new pgSession({ pool, tableName: "user_sessions", createTableIfMissing: false, pruneSessionInterval: false }),
  secret: process.env.SESSION_SECRET ||
    crypto.createHash("sha256").update("class-manager|" + DB_URL).digest("hex"),
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: "lax", secure: "auto", maxAge: 8 * 60 * 60 * 1000 }
}));

const auth = h(async (req, res, next) => {
  const id = req.session && req.session.userId;
  if (!id) return fail(res, 401, "Bạn chưa đăng nhập hoặc phiên đã hết hạn.");
  const u = await one("SELECT id,username,full_name,role,team_id,active FROM users WHERE id=$1", [id]);
  if (!u || !u.active) {
    req.session.destroy(() => {});
    return fail(res, 401, "Tài khoản không khả dụng.");
  }
  req.user = u;
  next();
});
const role = (...roles) => [
  auth,
  (req, res, next) => (roles.includes(req.user.role) ? next() : fail(res, 403, "Bạn không có quyền thực hiện thao tác này."))
];

/* ------------------------------------------------------------- date/month */
function vnYearMonth() {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Ho_Chi_Minh", year: "numeric", month: "numeric" })
    .formatToParts(new Date());
  return {
    month: Number(parts.find((p) => p.type === "month").value),
    year: Number(parts.find((p) => p.type === "year").value)
  };
}
async function currentMonth() {
  const { month, year } = vnYearMonth();
  const m = await one("SELECT * FROM months WHERE month=$1 AND year=$2", [month, year]);
  if (m) return m;
  return one("INSERT INTO months(month,year) VALUES($1,$2) ON CONFLICT(month,year) DO UPDATE SET month=EXCLUDED.month RETURNING *", [month, year]);
}
async function pickMonth(req) {
  const id = normalizeId(req.query.month_id);
  if (id) {
    const m = await one("SELECT * FROM months WHERE id=$1", [id]);
    if (m) return m;
  }
  return currentMonth();
}

/* ------------------------------------------------------------ score logic */
async function getBase() {
  const r = await one("SELECT value FROM settings WHERE key='base_score'");
  const n = r ? Number(r.value) : 100;
  return Number.isFinite(n) ? n : 100;
}
function classify(total, cls) {
  const c = cls.find((x) => total >= x.min_score && total <= x.max_score);
  return c ? c.name : "Yếu";
}

async function studentStats(user, monthId) {
  const base = await getBase();
  const cls = await q("SELECT * FROM classifications ORDER BY min_score DESC");
  const rows = await q(`
    SELECT s.id, s.student_code, s.full_name, s.gender, s.team_id, t.name AS team_name,
      COALESCE(SUM(CASE WHEN sr.points>0 THEN sr.points END),0)::int AS plus,
      COALESCE(SUM(CASE WHEN sr.points<0 THEN -sr.points END),0)::int AS minus,
      (COUNT(sr.id) FILTER (WHERE sr.points<0))::int AS violations
    FROM students s
    LEFT JOIN teams t ON t.id=s.team_id
    LEFT JOIN score_records sr ON sr.student_id=s.id AND sr.month_id=$1
    WHERE s.active=TRUE AND ($2::int IS NULL OR s.team_id=$2)
    GROUP BY s.id, t.name
    ORDER BY s.team_id NULLS LAST, s.full_name`, [monthId, teamFilter(user)]);
  const cr = await q(`
    SELECT DISTINCT ON (student_id) student_id, rating, note
    FROM conduct_records WHERE month_id=$1 ORDER BY student_id, created_at DESC, id DESC`, [monthId]);
  const cm = new Map(cr.map((x) => [Number(x.student_id), x]));
  const students = rows.map((s) => {
    const total = base + s.plus - s.minus;
    const c = cm.get(Number(s.id));
    return {
      ...s, total,
      classification: classify(total, cls),
      conduct: c ? c.rating : "Chưa xếp",
      conduct_note: c ? c.note || "" : ""
    };
  });
  return { base, students };
}

/* -------------------------------------------------------------- pages/auth */
app.get("/login", (req, res) => {
  if (req.session.userId) return res.redirect("/");
  res.sendFile(path.join(PUBLIC_DIR, "login.html"));
});
app.post("/login", h(async (req, res) => {
  const username = str(req.body.username);
  const password = String(req.body.password || "");
  const u = await one("SELECT * FROM users WHERE username=$1 AND active=TRUE", [username]);
  if (!u || !bcrypt.compareSync(password, u.password_hash)) return res.redirect("/login?error=1");
  req.session.regenerate((err) => {
    if (err) return res.redirect("/login?error=1");
    req.session.userId = u.id;
    req.session.save(() => res.redirect("/"));
  });
}));
app.post("/logout", (req, res) => {
  req.session.destroy(() => {
    res.clearCookie("connect.sid");
    res.redirect("/login");
  });
});
app.get("/", (req, res) => {
  if (!req.session.userId) return res.redirect("/login");
  res.sendFile(path.join(PUBLIC_DIR, "index.html"));
});

/* --------------------------------------------------------------------- API */
app.get("/api/health", h(async (req, res) => {
  await q("SELECT 1");
  ok(res, { message: "Server + database OK", time: new Date().toISOString() });
}));

app.get("/api/me", auth, (req, res) => ok(res, { user: req.user }));

app.post("/api/me/password", auth, h(async (req, res) => {
  const cur = String(req.body.current || ""), pw = String(req.body.password || "");
  if (pw.length < 6) return fail(res, 400, "Mật khẩu mới tối thiểu 6 ký tự.");
  const u = await one("SELECT password_hash FROM users WHERE id=$1", [req.user.id]);
  if (!bcrypt.compareSync(cur, u.password_hash)) return fail(res, 400, "Mật khẩu hiện tại không đúng.");
  await q("UPDATE users SET password_hash=$1 WHERE id=$2", [bcrypt.hashSync(pw, 10), req.user.id]);
  ok(res);
}));

app.get("/api/months", auth, h(async (req, res) => {
  const cur = await currentMonth();
  const months = await q("SELECT * FROM months ORDER BY year DESC, month DESC");
  ok(res, { months: months.map((m) => ({ ...m, current: m.id === cur.id })) });
}));

/* ---- settings */
app.get("/api/settings", auth, h(async (req, res) => ok(res, { base_score: await getBase() })));
app.put("/api/settings", role("ADMIN"), h(async (req, res) => {
  const n = Number(req.body.base_score);
  if (!Number.isInteger(n) || n < 0 || n > 1000) return fail(res, 400, "Điểm gốc phải là số nguyên từ 0 đến 1000.");
  await q("INSERT INTO settings(key,value) VALUES('base_score',$1) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value", [String(n)]);
  ok(res);
}));

/* ---- dashboard */
app.get("/api/dashboard", auth, h(async (req, res) => {
  const mo = await pickMonth(req);
  const { base, students } = await studentStats(req.user, mo.id);
  let teams = await q("SELECT id,name FROM teams ORDER BY id");
  const tf = teamFilter(req.user);
  if (tf) teams = teams.filter((t) => Number(t.id) === Number(tf));
  const teamStats = teams.map((t) => {
    const ss = students.filter((s) => Number(s.team_id) === Number(t.id));
    const total = ss.reduce((n, s) => n + s.total, 0);
    return {
      id: t.id, name: t.name, count: ss.length, total,
      plus: ss.reduce((n, s) => n + s.plus, 0),
      minus: ss.reduce((n, s) => n + s.minus, 0),
      avg: ss.length ? Number((total / ss.length).toFixed(1)) : 0
    };
  }).sort((a, b) => b.avg - a.avg || a.id - b.id);

  const violations = await q(`
    SELECT sr.id, s.full_name, sr.points, sr.description, sr.created_at, r.name AS rule_name
    FROM score_records sr JOIN students s ON s.id=sr.student_id
    LEFT JOIN score_rules r ON r.id=sr.rule_id
    WHERE sr.month_id=$1 AND sr.points<0 AND ($2::int IS NULL OR s.team_id=$2)
    ORDER BY sr.created_at DESC LIMIT 8`, [mo.id, tf]);

  const cur = await currentMonth();
  ok(res, {
    month: mo, is_current: mo.id === cur.id, base, students, teams: teamStats, violations,
    stats: {
      students: students.length,
      teams: teamStats.length,
      avg: students.length ? Number((students.reduce((n, s) => n + s.total, 0) / students.length).toFixed(1)) : 0,
      plus: students.reduce((n, s) => n + s.plus, 0),
      minus: students.reduce((n, s) => n + s.minus, 0),
      violations: students.reduce((n, s) => n + s.violations, 0)
    }
  });
}));

/* ---- teams */
app.get("/api/teams", auth, h(async (req, res) => {
  let teams = await q("SELECT * FROM teams ORDER BY id");
  const tf = teamFilter(req.user);
  if (tf) teams = teams.filter((t) => Number(t.id) === Number(tf));
  ok(res, { teams });
}));
app.post("/api/teams", role("ADMIN"), h(async (req, res) => {
  const name = str(req.body.name);
  if (!name) return fail(res, 400, "Tên tổ là bắt buộc.");
  try {
    await q("INSERT INTO teams(name) VALUES($1)", [name]);
    ok(res);
  } catch (e) { fail(res, 400, e.code === "23505" ? "Tên tổ đã tồn tại." : "Không thể thêm tổ."); }
}));
app.put("/api/teams/:id", role("ADMIN"), h(async (req, res) => {
  const name = str(req.body.name);
  if (!name) return fail(res, 400, "Tên tổ là bắt buộc.");
  try {
    await q("UPDATE teams SET name=$1 WHERE id=$2", [name, normalizeId(req.params.id)]);
    ok(res);
  } catch (e) { fail(res, 400, e.code === "23505" ? "Tên tổ đã tồn tại." : "Không thể đổi tên tổ."); }
}));
app.delete("/api/teams/:id", role("ADMIN"), h(async (req, res) => {
  const id = normalizeId(req.params.id);
  await q("UPDATE users SET team_id=NULL WHERE team_id=$1", [id]);
  await q("UPDATE students SET team_id=NULL WHERE team_id=$1", [id]);
  await q("DELETE FROM teams WHERE id=$1", [id]);
  ok(res);
}));

/* ---- students */
app.get("/api/students", auth, h(async (req, res) => {
  const students = await q(`
    SELECT s.*, t.name AS team_name FROM students s LEFT JOIN teams t ON t.id=s.team_id
    WHERE s.active=TRUE AND ($1::int IS NULL OR s.team_id=$1)
    ORDER BY s.team_id NULLS LAST, s.full_name`, [teamFilter(req.user)]);
  ok(res, { students });
}));
async function validTeam(v) {
  const id = normalizeId(v);
  if (!id) return null;
  return (await one("SELECT id FROM teams WHERE id=$1", [id])) ? id : null;
}
app.post("/api/students", role("ADMIN", "CLASS_LEADER"), h(async (req, res) => {
  const code = str(req.body.student_code), name = str(req.body.full_name);
  if (!code || !name) return fail(res, 400, "Mã học sinh và họ tên là bắt buộc.");
  const gender = ["Nam", "Nữ"].includes(req.body.gender) ? req.body.gender : "";
  try {
    await q("INSERT INTO students(student_code,full_name,gender,team_id) VALUES($1,$2,$3,$4)",
      [code, name, gender, await validTeam(req.body.team_id)]);
    ok(res);
  } catch (e) { fail(res, 400, e.code === "23505" ? "Mã học sinh đã tồn tại." : "Không thể thêm học sinh."); }
}));
app.put("/api/students/:id", role("ADMIN", "CLASS_LEADER"), h(async (req, res) => {
  const code = str(req.body.student_code), name = str(req.body.full_name);
  if (!code || !name) return fail(res, 400, "Mã học sinh và họ tên là bắt buộc.");
  const gender = ["Nam", "Nữ"].includes(req.body.gender) ? req.body.gender : "";
  try {
    await q("UPDATE students SET student_code=$1, full_name=$2, gender=$3, team_id=$4 WHERE id=$5",
      [code, name, gender, await validTeam(req.body.team_id), normalizeId(req.params.id)]);
    ok(res);
  } catch (e) { fail(res, 400, e.code === "23505" ? "Mã học sinh đã tồn tại." : "Không thể cập nhật."); }
}));
app.delete("/api/students/:id", role("ADMIN", "CLASS_LEADER"), h(async (req, res) => {
  await q("UPDATE students SET active=FALSE WHERE id=$1", [normalizeId(req.params.id)]);
  ok(res);
}));
// Nhập nhiều học sinh: mỗi dòng "Mã, Họ tên, Giới tính, Tổ"
app.post("/api/students/import", role("ADMIN", "CLASS_LEADER"), h(async (req, res) => {
  const lines = String(req.body.text || "").split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (!lines.length) return fail(res, 400, "Chưa có dữ liệu để nhập.");
  if (lines.length > 300) return fail(res, 400, "Tối đa 300 dòng mỗi lần nhập.");
  const teams = await q("SELECT id,name FROM teams");
  const findTeam = (v) => {
    const s = str(v).toLowerCase();
    if (!s) return null;
    const t = teams.find((x) => x.name.toLowerCase() === s || x.name.toLowerCase() === "tổ " + s);
    return t ? t.id : null;
  };
  let added = 0, skipped = 0;
  const errors = [];
  for (const [i, line] of lines.entries()) {
    const p = line.split(/[,;\t]/).map((x) => x.trim());
    if (p.length < 2 || !p[0] || !p[1]) { errors.push(`Dòng ${i + 1}: thiếu mã hoặc họ tên`); continue; }
    const gender = ["nam", "nữ", "nu"].includes((p[2] || "").toLowerCase()) ? ((p[2].toLowerCase() === "nam") ? "Nam" : "Nữ") : "";
    const r = await pool.query(
      "INSERT INTO students(student_code,full_name,gender,team_id) VALUES($1,$2,$3,$4) ON CONFLICT(student_code) DO NOTHING",
      [p[0], p[1], gender, findTeam(p[3])]);
    if (r.rowCount) added++; else skipped++;
  }
  ok(res, { added, skipped, errors });
}));

/* ---- rules */
app.get("/api/rules", auth, h(async (req, res) =>
  ok(res, { rules: await q("SELECT * FROM score_rules ORDER BY type DESC, id") })));
app.post("/api/rules", role("ADMIN"), h(async (req, res) => {
  const name = str(req.body.name), type = str(req.body.type), points = Number(req.body.points);
  if (!name || !["PLUS", "MINUS"].includes(type) || !Number.isInteger(points) || points <= 0)
    return fail(res, 400, "Quy tắc không hợp lệ.");
  await q("INSERT INTO score_rules(name,type,points,description) VALUES($1,$2,$3,$4)", [name, type, points, str(req.body.description)]);
  ok(res);
}));
app.delete("/api/rules/:id", role("ADMIN"), h(async (req, res) => {
  await q("DELETE FROM score_rules WHERE id=$1", [normalizeId(req.params.id)]);
  ok(res);
}));

/* ---- scores */
app.post("/api/scores", role(...ROLES), h(async (req, res) => {
  const studentId = normalizeId(req.body.student_id), ruleId = normalizeId(req.body.rule_id);
  if (!studentId || !ruleId) return fail(res, 400, "Thiếu học sinh hoặc quy tắc điểm.");
  const student = await one("SELECT * FROM students WHERE id=$1 AND active=TRUE", [studentId]);
  const tf = teamFilter(req.user);
  if (!student || (tf && Number(student.team_id) !== Number(tf)))
    return fail(res, 403, "Bạn không được ghi điểm cho học sinh này.");
  const rule = await one("SELECT * FROM score_rules WHERE id=$1", [ruleId]);
  if (!rule) return fail(res, 404, "Không tìm thấy quy tắc.");
  const mo = await currentMonth();
  const points = rule.type === "PLUS" ? Number(rule.points) : -Number(rule.points);
  await q("INSERT INTO score_records(student_id,month_id,rule_id,points,description,recorded_by) VALUES($1,$2,$3,$4,$5,$6)",
    [studentId, mo.id, rule.id, points, str(req.body.description) || rule.name, req.user.id]);
  ok(res);
}));

app.get("/api/records", auth, h(async (req, res) => {
  const mo = await pickMonth(req);
  const type = str(req.query.type);
  const cond = type === "minus" ? "AND sr.points<0" : type === "plus" ? "AND sr.points>0" : "";
  const records = await q(`
    SELECT sr.id, sr.points, sr.description, sr.created_at, s.full_name, t.name AS team_name,
           r.name AS rule_name, u.full_name AS recorder
    FROM score_records sr
    JOIN students s ON s.id=sr.student_id
    LEFT JOIN teams t ON t.id=s.team_id
    LEFT JOIN score_rules r ON r.id=sr.rule_id
    LEFT JOIN users u ON u.id=sr.recorded_by
    WHERE sr.month_id=$1 AND ($2::int IS NULL OR s.team_id=$2) ${cond}
    ORDER BY sr.created_at DESC, sr.id DESC LIMIT 500`, [mo.id, teamFilter(req.user)]);
  ok(res, { month: mo, records });
}));
app.delete("/api/records/:id", role("ADMIN", "CLASS_LEADER", "CLASS_VICE"), h(async (req, res) => {
  await q("DELETE FROM score_records WHERE id=$1", [normalizeId(req.params.id)]);
  ok(res);
}));

/* ---- conduct */
app.post("/api/conduct", role("ADMIN", "CLASS_LEADER", "CLASS_VICE"), h(async (req, res) => {
  const studentId = normalizeId(req.body.student_id), rating = str(req.body.rating);
  if (!studentId || !RATINGS.includes(rating)) return fail(res, 400, "Dữ liệu hạnh kiểm không hợp lệ.");
  const student = await one("SELECT id FROM students WHERE id=$1 AND active=TRUE", [studentId]);
  if (!student) return fail(res, 404, "Không tìm thấy học sinh.");
  const mo = await currentMonth();
  const note = str(req.body.note);
  const up = await pool.query(
    "UPDATE conduct_records SET rating=$1, note=$2, recorded_by=$3, created_at=NOW() WHERE student_id=$4 AND month_id=$5",
    [rating, note, req.user.id, studentId, mo.id]);
  if (!up.rowCount)
    await q("INSERT INTO conduct_records(student_id,month_id,rating,note,recorded_by) VALUES($1,$2,$3,$4,$5)",
      [studentId, mo.id, rating, note, req.user.id]);
  ok(res);
}));

/* ---- users */
app.get("/api/users", role("ADMIN"), h(async (req, res) => {
  ok(res, { users: await q(`
    SELECT u.id,u.username,u.full_name,u.role,u.team_id,t.name AS team_name,u.active,u.created_at
    FROM users u LEFT JOIN teams t ON t.id=u.team_id ORDER BY u.id`) });
}));
app.post("/api/users", role("ADMIN"), h(async (req, res) => {
  const username = str(req.body.username), password = String(req.body.password || "");
  const fullName = str(req.body.full_name), roleValue = str(req.body.role);
  const team = await validTeam(req.body.team_id);
  if (!username || password.length < 6 || !fullName || !ROLES.includes(roleValue))
    return fail(res, 400, "Cần tên đăng nhập, họ tên, quyền hợp lệ và mật khẩu tối thiểu 6 ký tự.");
  if (roleValue === "TEAM_LEADER" && !team) return fail(res, 400, "Tổ trưởng phải được gán tổ.");
  try {
    await q("INSERT INTO users(username,password_hash,full_name,role,team_id) VALUES($1,$2,$3,$4,$5)",
      [username, bcrypt.hashSync(password, 10), fullName, roleValue, roleValue === "TEAM_LEADER" ? team : null]);
    ok(res);
  } catch (e) { fail(res, 400, e.code === "23505" ? "Tên đăng nhập đã tồn tại." : "Không thể tạo tài khoản."); }
}));
app.put("/api/users/:id", role("ADMIN"), h(async (req, res) => {
  const id = normalizeId(req.params.id);
  const fullName = str(req.body.full_name), roleValue = str(req.body.role);
  const team = await validTeam(req.body.team_id);
  if (!id || !fullName || !ROLES.includes(roleValue)) return fail(res, 400, "Dữ liệu không hợp lệ.");
  if (id === req.user.id && roleValue !== req.user.role) return fail(res, 400, "Không thể tự đổi quyền của chính mình.");
  if (roleValue === "TEAM_LEADER" && !team) return fail(res, 400, "Tổ trưởng phải được gán tổ.");
  await q("UPDATE users SET full_name=$1, role=$2, team_id=$3 WHERE id=$4",
    [fullName, roleValue, roleValue === "TEAM_LEADER" ? team : null, id]);
  ok(res);
}));
app.patch("/api/users/:id/toggle", role("ADMIN"), h(async (req, res) => {
  await q("UPDATE users SET active=NOT active WHERE id=$1 AND id<>$2", [normalizeId(req.params.id), req.user.id]);
  ok(res);
}));
app.patch("/api/users/:id/password", role("ADMIN"), h(async (req, res) => {
  const pw = String(req.body.password || "");
  if (pw.length < 6) return fail(res, 400, "Mật khẩu tối thiểu 6 ký tự.");
  await q("UPDATE users SET password_hash=$1 WHERE id=$2", [bcrypt.hashSync(pw, 10), normalizeId(req.params.id)]);
  ok(res);
}));

/* ---- export */
app.get("/api/export.xlsx", role("ADMIN", "CLASS_LEADER", "CLASS_VICE"), h(async (req, res) => {
  const mo = await pickMonth(req);
  const { base, students } = await studentStats(req.user, mo.id);
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet(`Tháng ${mo.month}-${mo.year}`);
  ws.columns = [
    { header: "STT", key: "stt", width: 6 }, { header: "Mã HS", key: "code", width: 14 },
    { header: "Họ tên", key: "name", width: 28 }, { header: "Tổ", key: "team", width: 14 },
    { header: "Điểm gốc", key: "base", width: 11 }, { header: "Điểm cộng", key: "plus", width: 12 },
    { header: "Điểm trừ", key: "minus", width: 12 }, { header: "Tổng", key: "total", width: 10 },
    { header: "Xếp loại", key: "cls", width: 16 }, { header: "Hạnh kiểm", key: "conduct", width: 16 },
    { header: "Ghi chú", key: "note", width: 34 }
  ];
  students.forEach((s, i) => ws.addRow({
    stt: i + 1, code: s.student_code, name: s.full_name, team: s.team_name || "", base,
    plus: s.plus, minus: s.minus, total: s.total, cls: s.classification, conduct: s.conduct, note: s.conduct_note
  }));
  const head = ws.getRow(1);
  head.font = { bold: true, color: { argb: "FFFFFFFF" } };
  head.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF087B4A" } };
  head.alignment = { vertical: "middle", horizontal: "center" };
  ws.views = [{ state: "frozen", ySplit: 1 }];
  res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  res.setHeader("Content-Disposition", `attachment; filename="quan-ly-lop-thang-${mo.month}-${mo.year}.xlsx"`);
  await wb.xlsx.write(res);
  res.end();
}));

app.get("/api/export.docx", role("ADMIN", "CLASS_LEADER", "CLASS_VICE"), h(async (req, res) => {
  const mo = await pickMonth(req);
  const { students } = await studentStats(req.user, mo.id);
  const cell = (text, bold = false, fill) => new TableCell({
    shading: fill ? { type: ShadingType.CLEAR, fill, color: "auto" } : undefined,
    children: [new Paragraph({ children: [new TextRun({ text: String(text), bold })] })]
  });
  const rows = [new TableRow({
    tableHeader: true,
    children: ["STT", "Mã HS", "Họ tên", "Tổ", "Tổng điểm", "Xếp loại", "Hạnh kiểm"].map((x) => cell(x, true, "DDF6E8"))
  })];
  students.forEach((s, i) => rows.push(new TableRow({
    children: [i + 1, s.student_code, s.full_name, s.team_name || "", s.total, s.classification, s.conduct].map((x) => cell(x))
  })));
  const doc = new Document({
    sections: [{
      children: [
        new Paragraph({
          alignment: AlignmentType.CENTER,
          children: [new TextRun({ text: `BẢNG THI ĐUA LỚP - THÁNG ${mo.month}/${mo.year}`, bold: true, size: 32 })]
        }),
        new Paragraph({ text: "" }),
        new Table({ width: { size: 100, type: WidthType.PERCENTAGE }, rows })
      ]
    }]
  });
  const buf = await Packer.toBuffer(doc);
  res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
  res.setHeader("Content-Disposition", `attachment; filename="quan-ly-lop-thang-${mo.month}-${mo.year}.docx"`);
  res.end(buf);
}));

/* ----------------------------------------------------------------- errors */
app.use("/api", (req, res) => fail(res, 404, "Không tìm thấy API."));
app.use((err, req, res, next) => {
  console.error(err);
  if (res.headersSent) return next(err);
  if (req.path.startsWith("/api/")) return fail(res, 500, "Có lỗi máy chủ. Kiểm tra log để biết chi tiết.");
  res.status(500).send("Có lỗi máy chủ.");
});

module.exports = app;

if (require.main === module) {
  app.listen(PORT, () => console.log(`Chạy tại http://localhost:${PORT}`));
}
