const express = require("express");
const session = require("express-session");
const pgSession = require("connect-pg-simple")(session);
const { Pool } = require("pg");
const bcrypt = require("bcryptjs");
const ExcelJS = require("exceljs");
const { Document, Packer, Paragraph, Table, TableRow, TableCell, WidthType } = require("docx");

const app = express();
const PORT = process.env.PORT || 3000;
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false,
  max: 5
});

const ROLES = ["ADMIN", "CLASS_LEADER", "CLASS_VICE", "TEAM_LEADER"];
const roleName = {
  ADMIN: "Admin",
  CLASS_LEADER: "Lớp trưởng",
  CLASS_VICE: "Lớp phó",
  TEAM_LEADER: "Tổ trưởng"
};

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use(session({
  store: process.env.DATABASE_URL ? new pgSession({
    pool,
    tableName: "user_sessions",
    createTableIfMissing: true
  }) : undefined,
  secret: process.env.SESSION_SECRET || "dev-only-change-me",
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    maxAge: 8 * 60 * 60 * 1000
  }
}));

app.use(express.static("public"));

async function q(text, params = []) {
  const r = await pool.query(text, params);
  return r.rows;
}
async function one(text, params = []) {
  const r = await pool.query(text, params);
  return r.rows[0] || null;
}
function ok(res, data = {}) { return res.json({ ok: true, ...data }); }
function fail(res, code, message) { return res.status(code).json({ ok: false, error: message }); }

function auth(req, res, next) {
  if (!req.session.user) return fail(res, 401, "Bạn chưa đăng nhập hoặc phiên đã hết hạn.");
  next();
}
function role(...roles) {
  return (req, res, next) => {
    if (!req.session.user) return fail(res, 401, "Bạn chưa đăng nhập.");
    if (!roles.includes(req.session.user.role)) return fail(res, 403, "Bạn không có quyền thực hiện thao tác này.");
    next();
  };
}
function pageAuth(req, res, next) {
  if (!req.session.user) return res.redirect("/login");
  next();
}
function monthKey() {
  const d = new Date();
  return { month: d.getMonth() + 1, year: d.getFullYear() };
}
async function currentMonth() {
  const m = monthKey();
  return one("INSERT INTO months(month,year) VALUES($1,$2) ON CONFLICT(month,year) DO UPDATE SET month=EXCLUDED.month RETURNING *", [m.month, m.year]);
}
function canSeeStudent(user, student) {
  return user.role !== "TEAM_LEADER" || Number(student.team_id) === Number(user.team_id);
}
function normalizeId(v) {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : null;
}

async function initDb() {
  await q(`
    CREATE TABLE IF NOT EXISTS users(
      id SERIAL PRIMARY KEY,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      full_name TEXT NOT NULL,
      role TEXT NOT NULL CHECK(role IN ('ADMIN','CLASS_LEADER','CLASS_VICE','TEAM_LEADER')),
      team_id INTEGER,
      active BOOLEAN NOT NULL DEFAULT TRUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS teams(
      id SERIAL PRIMARY KEY,
      name TEXT UNIQUE NOT NULL,
      leader_student_id INTEGER
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
    CREATE INDEX IF NOT EXISTS idx_scores_month_student ON score_records(month_id, student_id);
    CREATE INDEX IF NOT EXISTS idx_conduct_month_student ON conduct_records(month_id, student_id);
  `);

  const seed = String(process.env.SEED_DEMO || "").toLowerCase() === "true";
  if (!seed) {
    await ensureAdminOnly();
    return;
  }

  if (!(await one("SELECT id FROM users LIMIT 1"))) {
    const h = bcrypt.hashSync("admin123", 10);
    await q("INSERT INTO users(username,password_hash,full_name,role) VALUES($1,$2,$3,$4)", ["admin", h, "Quản trị viên", "ADMIN"]);
  }
  if (!(await one("SELECT id FROM teams LIMIT 1"))) {
    for (let i = 1; i <= 4; i++) await q("INSERT INTO teams(name) VALUES($1) ON CONFLICT(name) DO NOTHING", [`Tổ ${i}`]);
  }
  if (!(await one("SELECT id FROM score_rules LIMIT 1"))) {
    const rules = [
      ["Phát biểu xây dựng bài","PLUS",2,"Có phát biểu xây dựng bài"],
      ["Giúp đỡ bạn","PLUS",2,"Hỗ trợ bạn học"],
      ["Hoàn thành nhiệm vụ","PLUS",3,"Hoàn thành tốt nhiệm vụ"],
      ["Đi học muộn","MINUS",2,"Đi học muộn"],
      ["Không làm bài","MINUS",3,"Không hoàn thành bài tập"],
      ["Không đồng phục","MINUS",2,"Không đúng đồng phục"],
      ["Vi phạm nội quy","MINUS",5,"Vi phạm nội quy lớp"]
    ];
    for (const r of rules) await q("INSERT INTO score_rules(name,type,points,description) VALUES($1,$2,$3,$4)", r);
  }
  if (!(await one("SELECT id FROM classifications LIMIT 1"))) {
    for (const r of [[90,999,"Tốt"],[80,89,"Khá"],[65,79,"Trung bình"],[-999,64,"Yếu"]])
      await q("INSERT INTO classifications(min_score,max_score,name) VALUES($1,$2,$3)", r);
  }
  const cm = await currentMonth();
  if (!(await one("SELECT id FROM students LIMIT 1"))) {
    const teams = await q("SELECT id FROM teams ORDER BY id");
    const names = [
      ["HS001","Nguyễn Minh Anh","Nữ"],["HS002","Trần Quốc Bảo","Nam"],
      ["HS003","Lê Hoàng Nam","Nam"],["HS004","Phạm Ngọc Mai","Nữ"],
      ["HS005","Võ Thành Đạt","Nam"],["HS006","Đỗ Khánh Linh","Nữ"],
      ["HS007","Nguyễn Gia Huy","Nam"],["HS008","Trương Hà My","Nữ"],
      ["HS009","Bùi Đức Long","Nam"],["HS010","Hoàng Yến Nhi","Nữ"],
      ["HS011","Phan Nhật Minh","Nam"],["HS012","Lâm Thảo Vy","Nữ"]
    ];
    for (let i=0;i<names.length;i++) {
      await q("INSERT INTO students(student_code,full_name,gender,team_id) VALUES($1,$2,$3,$4)",
        [...names[i], teams[i % teams.length].id]);
    }
    const admin = await one("SELECT id FROM users WHERE username='admin'");
    const plus = await q("SELECT * FROM score_rules WHERE type='PLUS' ORDER BY id");
    const minus = await q("SELECT * FROM score_rules WHERE type='MINUS' ORDER BY id");
    const students = await q("SELECT id FROM students ORDER BY id");
    for (let i=0;i<students.length;i++) {
      if (i % 2 === 0) {
        const r = plus[i % plus.length];
        await q("INSERT INTO score_records(student_id,month_id,rule_id,points,description,recorded_by) VALUES($1,$2,$3,$4,$5,$6)",
          [students[i].id, cm.id, r.id, r.points, "Dữ liệu mẫu", admin.id]);
      }
      if (i % 3 === 0) {
        const r = minus[i % minus.length];
        await q("INSERT INTO score_records(student_id,month_id,rule_id,points,description,recorded_by) VALUES($1,$2,$3,$4,$5,$6)",
          [students[i].id, cm.id, r.id, -r.points, "Dữ liệu mẫu", admin.id]);
        await q("INSERT INTO conduct_records(student_id,month_id,rating,note,recorded_by) VALUES($1,$2,$3,$4,$5)",
          [students[i].id, cm.id, "Khá", "Có vi phạm trong tháng", admin.id]);
      }
    }
  }
}
async function ensureAdminOnly() {
  if (!(await one("SELECT id FROM users LIMIT 1"))) {
    const h = bcrypt.hashSync(process.env.ADMIN_PASSWORD || "admin123", 10);
    await q("INSERT INTO users(username,password_hash,full_name,role) VALUES($1,$2,$3,$4)",
      [process.env.ADMIN_USERNAME || "admin", h, "Quản trị viên", "ADMIN"]);
  }
}

app.get("/login",(req,res)=>{
  if(req.session.user) return res.redirect("/");
  res.sendFile(__dirname + "/public/login.html");
});
app.post("/login",async(req,res)=>{
  try {
    const username = String(req.body.username || "").trim();
    const password = String(req.body.password || "");
    const u = await one("SELECT * FROM users WHERE username=$1 AND active=TRUE", [username]);
    if(!u || !bcrypt.compareSync(password,u.password_hash)) return res.redirect("/login?error=1");
    req.session.user = {id:u.id,username:u.username,full_name:u.full_name,role:u.role,team_id:u.team_id};
    res.redirect("/");
  } catch(e) { res.redirect("/login?error=1"); }
});
app.post("/logout",(req,res)=>req.session.destroy(()=>res.redirect("/login")));
app.get("/",pageAuth,(req,res)=>res.sendFile(__dirname + "/public/index.html"));

app.get("/api/me",auth,(req,res)=>ok(res,{user:req.session.user}));
app.get("/api/health",async(req,res)=>{
  try { await q("SELECT 1"); ok(res,{message:"Server + database OK",time:new Date().toISOString()}); }
  catch(e){ fail(res,500,"Database chưa kết nối."); }
});

app.get("/api/teams",auth,async(req,res)=>{
  let teams=await q("SELECT * FROM teams ORDER BY id");
  if(req.session.user.role==="TEAM_LEADER") teams=teams.filter(t=>Number(t.id)===Number(req.session.user.team_id));
  ok(res,{teams});
});

app.get("/api/rules",auth,async(req,res)=>ok(res,{rules:await q("SELECT * FROM score_rules ORDER BY type DESC,id")}));

app.get("/api/dashboard",auth,async(req,res)=>{
  const mo=await currentMonth();
  let students=await q(`
    SELECT s.*, t.name AS team_name,
      COALESCE(SUM(sr.points),0)::int AS total,
      COALESCE(SUM(CASE WHEN sr.points>0 THEN sr.points ELSE 0 END),0)::int AS plus,
      COALESCE(SUM(CASE WHEN sr.points<0 THEN ABS(sr.points) ELSE 0 END),0)::int AS minus,
      COUNT(sr.id)::int AS records
    FROM students s
    LEFT JOIN teams t ON t.id=s.team_id
    LEFT JOIN score_records sr ON sr.student_id=s.id AND sr.month_id=$1
    WHERE s.active=TRUE
    GROUP BY s.id,t.name
    ORDER BY s.team_id NULLS LAST,total DESC,s.full_name
  `,[mo.id]);
  if(req.session.user.role==="TEAM_LEADER") students=students.filter(s=>canSeeStudent(req.session.user,s));

  const conductRows=await q(`
    SELECT DISTINCT ON (student_id) student_id,rating,note,created_at
    FROM conduct_records WHERE month_id=$1 ORDER BY student_id,created_at DESC
  `,[mo.id]);
  const cm = new Map(conductRows.map(x=>[Number(x.student_id),x]));
  students = students.map(s=>({
    ...s,
    total:Number(s.total),plus:Number(s.plus),minus:Number(s.minus),records:Number(s.records),
    classification: Number(s.total)>=90?"Tốt":Number(s.total)>=80?"Khá":Number(s.total)>=65?"Trung bình":"Yếu",
    conduct: cm.get(Number(s.id))?.rating || "Chưa xếp",
    conduct_note: cm.get(Number(s.id))?.note || ""
  }));

  let violations=await q(`
    SELECT sr.id,s.full_name,s.team_id,sr.points,sr.description,sr.created_at,u.full_name AS recorder
    FROM score_records sr JOIN students s ON s.id=sr.student_id
    LEFT JOIN users u ON u.id=sr.recorded_by
    WHERE sr.month_id=$1 AND sr.points<0
    ORDER BY sr.created_at DESC LIMIT 50
  `,[mo.id]);
  if(req.session.user.role==="TEAM_LEADER") violations=violations.filter(v=>Number(v.team_id)===Number(req.session.user.team_id));

  let teams=await q(`
    SELECT t.id,t.name,COUNT(s.id)::int AS count,COALESCE(SUM(x.total),0)::int AS total
    FROM teams t
    LEFT JOIN students s ON s.team_id=t.id AND s.active=TRUE
    LEFT JOIN LATERAL (
      SELECT COALESCE(SUM(sr.points),0)::int AS total
      FROM score_records sr WHERE sr.student_id=s.id AND sr.month_id=$1
    ) x ON TRUE
    GROUP BY t.id ORDER BY t.id
  `,[mo.id]);
  if(req.session.user.role==="TEAM_LEADER") teams=teams.filter(t=>Number(t.id)===Number(req.session.user.team_id));
  teams=teams.map(t=>({...t,avg:t.count?Number((t.total/t.count).toFixed(1)):0}));

  ok(res,{
    month:mo,students,teams,violations,
    stats:{
      students:students.length,
      total:students.reduce((n,s)=>n+s.total,0),
      plus:students.reduce((n,s)=>n+s.plus,0),
      minus:students.reduce((n,s)=>n+s.minus,0),
      violations:students.reduce((n,s)=>n+s.records,0)
    }
  });
});

app.get("/api/students",auth,async(req,res)=>{
  let ss=await q("SELECT s.*,t.name AS team_name FROM students s LEFT JOIN teams t ON t.id=s.team_id WHERE s.active=TRUE ORDER BY s.team_id NULLS LAST,s.full_name");
  if(req.session.user.role==="TEAM_LEADER") ss=ss.filter(s=>canSeeStudent(req.session.user,s));
  ok(res,{students:ss});
});

app.post("/api/students",role("ADMIN","CLASS_LEADER"),async(req,res)=>{
  try {
    const code=String(req.body.student_code||"").trim(), name=String(req.body.full_name||"").trim();
    const team=normalizeId(req.body.team_id);
    if(!code||!name) return fail(res,400,"Mã học sinh và họ tên là bắt buộc.");
    await q("INSERT INTO students(student_code,full_name,gender,team_id) VALUES($1,$2,$3,$4)",[code,name,req.body.gender||"",team]);
    ok(res);
  } catch(e){ fail(res,400,e.code==="23505"?"Mã học sinh đã tồn tại.":"Không thể thêm học sinh."); }
});
app.delete("/api/students/:id",role("ADMIN","CLASS_LEADER"),async(req,res)=>{
  await q("UPDATE students SET active=FALSE WHERE id=$1",[normalizeId(req.params.id)]);
  ok(res);
});

app.post("/api/scores",role("ADMIN","CLASS_LEADER","CLASS_VICE","TEAM_LEADER"),async(req,res)=>{
  const studentId=normalizeId(req.body.student_id), ruleId=normalizeId(req.body.rule_id);
  if(!studentId||!ruleId) return fail(res,400,"Thiếu học sinh hoặc quy tắc điểm.");
  const student=await one("SELECT * FROM students WHERE id=$1 AND active=TRUE",[studentId]);
  if(!student||!canSeeStudent(req.session.user,student)) return fail(res,403,"Bạn không được ghi điểm cho học sinh này.");
  const rule=await one("SELECT * FROM score_rules WHERE id=$1",[ruleId]);
  if(!rule) return fail(res,404,"Không tìm thấy quy tắc.");
  const mo=await currentMonth();
  const points=rule.type==="PLUS"?Number(rule.points):-Number(rule.points);
  await q("INSERT INTO score_records(student_id,month_id,rule_id,points,description,recorded_by) VALUES($1,$2,$3,$4,$5,$6)",
    [studentId,mo.id,rule.id,points,String(req.body.description||"").trim(),req.session.user.id]);
  ok(res);
});

app.post("/api/conduct",role("ADMIN","CLASS_LEADER","CLASS_VICE"),async(req,res)=>{
  const studentId=normalizeId(req.body.student_id);
  const rating=String(req.body.rating||"");
  if(!studentId||!["Tốt","Khá","Trung bình","Yếu"].includes(rating)) return fail(res,400,"Dữ liệu hạnh kiểm không hợp lệ.");
  const student=await one("SELECT * FROM students WHERE id=$1 AND active=TRUE",[studentId]);
  if(!student) return fail(res,404,"Không tìm thấy học sinh.");
  const mo=await currentMonth();
  await q("INSERT INTO conduct_records(student_id,month_id,rating,note,recorded_by) VALUES($1,$2,$3,$4,$5)",
    [studentId,mo.id,rating,String(req.body.note||"").trim(),req.session.user.id]);
  ok(res);
});

app.get("/api/violations",auth,async(req,res)=>{
  const mo=await currentMonth();
  let rows=await q(`
    SELECT sr.*,s.full_name,s.team_id,r.name AS rule_name,u.full_name AS recorder
    FROM score_records sr JOIN students s ON s.id=sr.student_id
    LEFT JOIN score_rules r ON r.id=sr.rule_id
    LEFT JOIN users u ON u.id=sr.recorded_by
    WHERE sr.month_id=$1 AND sr.points<0 ORDER BY sr.created_at DESC
  `,[mo.id]);
  if(req.session.user.role==="TEAM_LEADER") rows=rows.filter(x=>Number(x.team_id)===Number(req.session.user.team_id));
  ok(res,{month:mo,violations:rows});
});

app.post("/api/rules",role("ADMIN"),async(req,res)=>{
  const name=String(req.body.name||"").trim(), type=String(req.body.type||"");
  const points=Number(req.body.points);
  if(!name||!["PLUS","MINUS"].includes(type)||!Number.isInteger(points)||points<=0) return fail(res,400,"Quy tắc không hợp lệ.");
  await q("INSERT INTO score_rules(name,type,points,description) VALUES($1,$2,$3,$4)",[name,type,points,String(req.body.description||"").trim()]);
  ok(res);
});
app.delete("/api/rules/:id",role("ADMIN"),async(req,res)=>{
  await q("DELETE FROM score_rules WHERE id=$1",[normalizeId(req.params.id)]);
  ok(res);
});

app.get("/api/users",role("ADMIN"),async(req,res)=>{
  ok(res,{users:await q("SELECT id,username,full_name,role,team_id,active,created_at FROM users ORDER BY id")});
});
app.post("/api/users",role("ADMIN"),async(req,res)=>{
  const username=String(req.body.username||"").trim(),password=String(req.body.password||"");
  const fullName=String(req.body.full_name||"").trim(), roleValue=String(req.body.role||"");
  const team=normalizeId(req.body.team_id);
  if(!username||password.length<6||!fullName||!ROLES.includes(roleValue)) return fail(res,400,"Tài khoản, họ tên, quyền hợp lệ và mật khẩu tối thiểu 6 ký tự.");
  if(roleValue==="TEAM_LEADER"&&!team) return fail(res,400,"Tổ trưởng phải được gán tổ.");
  try {
    const h=bcrypt.hashSync(password,10);
    await q("INSERT INTO users(username,password_hash,full_name,role,team_id) VALUES($1,$2,$3,$4,$5)",
      [username,h,fullName,roleValue,team]);
    ok(res);
  } catch(e){ fail(res,400,"Tên đăng nhập đã tồn tại."); }
});
app.patch("/api/users/:id/toggle",role("ADMIN"),async(req,res)=>{
  await q("UPDATE users SET active=NOT active WHERE id=$1 AND username<>'admin'",[normalizeId(req.params.id)]);
  ok(res);
});

app.get("/api/export.xlsx",role("ADMIN","CLASS_LEADER","CLASS_VICE"),async(req,res)=>{
  const d=await dashboardDataForExport(req);
  const wb=new ExcelJS.Workbook();
  const ws=wb.addWorksheet(`Tháng ${d.month.month}-${d.month.year}`);
  ws.columns=[
    {header:"Mã HS",key:"code",width:14},{header:"Họ tên",key:"name",width:28},
    {header:"Tổ",key:"team",width:14},{header:"Điểm cộng",key:"plus",width:14},
    {header:"Điểm trừ",key:"minus",width:14},{header:"Tổng",key:"total",width:12},
    {header:"Xếp loại",key:"classification",width:18},{header:"Hạnh kiểm",key:"conduct",width:18}
  ];
  d.students.forEach(s=>ws.addRow({code:s.student_code,name:s.full_name,team:s.team_name||"",plus:s.plus,minus:s.minus,total:s.total,classification:s.classification,conduct:s.conduct}));
  ws.getRow(1).font={bold:true};
  res.setHeader("Content-Type","application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  res.setHeader("Content-Disposition",`attachment; filename="quan-ly-lop-thang-${d.month.month}-${d.month.year}.xlsx"`);
  await wb.xlsx.write(res); res.end();
});

app.get("/api/export.docx",role("ADMIN","CLASS_LEADER","CLASS_VICE"),async(req,res)=>{
  const d=await dashboardDataForExport(req);
  const rows=[
    new TableRow({children:["Mã HS","Họ tên","Tổ","Tổng","Xếp loại","Hạnh kiểm"].map(x=>new TableCell({children:[new Paragraph(x)]}))})
  ];
  for(const s of d.students) rows.push(new TableRow({children:[
    s.student_code,s.full_name,s.team_name||"",String(s.total),s.classification,s.conduct
  ].map(x=>new TableCell({children:[new Paragraph(String(x))]}))}));
  const doc=new Document({sections:[{children:[
    new Paragraph(`QUẢN LÝ LỚP - THÁNG ${d.month.month}/${d.month.year}`),
    new Paragraph(""),
    new Table({width:{size:100,type:WidthType.PERCENTAGE},rows})
  ]}]});
  const buf=await Packer.toBuffer(doc);
  res.setHeader("Content-Type","application/vnd.openxmlformats-officedocument.wordprocessingml.document");
  res.setHeader("Content-Disposition",`attachment; filename="quan-ly-lop-thang-${d.month.month}-${d.month.year}.docx"`);
  res.end(buf);
});

async function dashboardDataForExport(req){
  const mo=await currentMonth();
  let students=await q(`
    SELECT s.*,t.name AS team_name,
      COALESCE(SUM(sr.points),0)::int AS total,
      COALESCE(SUM(CASE WHEN sr.points>0 THEN sr.points ELSE 0 END),0)::int AS plus,
      COALESCE(SUM(CASE WHEN sr.points<0 THEN ABS(sr.points) ELSE 0 END),0)::int AS minus
    FROM students s LEFT JOIN teams t ON t.id=s.team_id
    LEFT JOIN score_records sr ON sr.student_id=s.id AND sr.month_id=$1
    WHERE s.active=TRUE GROUP BY s.id,t.name ORDER BY s.team_id NULLS LAST,s.full_name
  `,[mo.id]);
  if(req.session.user.role==="TEAM_LEADER") students=students.filter(s=>canSeeStudent(req.session.user,s));
  const c=await q("SELECT DISTINCT ON(student_id) student_id,rating FROM conduct_records WHERE month_id=$1 ORDER BY student_id,created_at DESC",[mo.id]);
  const cm=new Map(c.map(x=>[Number(x.student_id),x.rating]));
  return {month:mo,students:students.map(s=>({...s,total:Number(s.total),plus:Number(s.plus),minus:Number(s.minus),
    classification:Number(s.total)>=90?"Tốt":Number(s.total)>=80?"Khá":Number(s.total)>=65?"Trung bình":"Yếu",
    conduct:cm.get(Number(s.id))||"Chưa xếp"}))};
}

app.use((err,req,res,next)=>{
  console.error(err);
  if(res.headersSent) return next(err);
  fail(res,500,"Có lỗi máy chủ. Kiểm tra log để biết chi tiết.");
});

let initPromise;
function ensureDb() {
  if (!initPromise) {
    initPromise = initDb().catch(err => {
      console.error("Database initialization failed:", err);
      initPromise = null;
      throw err;
    });
  }
  return initPromise;
}
app.use(async (req,res,next)=>{
  try { await ensureDb(); next(); }
  catch (e) { res.status(500).json({ok:false,error:"Không kết nối được database Supabase."}); }
});

module.exports = app;
