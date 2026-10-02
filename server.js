require("dotenv").config();
const express=require("express");
const session=require("express-session");
const bcrypt=require("bcryptjs");
const {createClient}=require("@supabase/supabase-js");
const ExcelJS=require("exceljs");
const {Document,Packer,Paragraph,Table,TableRow,TableCell,TextRun,WidthType,AlignmentType}=require("docx");

const app=express(),PORT=process.env.PORT||3000;
const SUPABASE_URL=process.env.SUPABASE_URL,SUPABASE_KEY=process.env.SUPABASE_SERVICE_ROLE_KEY;
if(!SUPABASE_URL||!SUPABASE_KEY){
  console.error("❌ Thiếu SUPABASE_URL hoặc SUPABASE_SERVICE_ROLE_KEY. Hãy tạo file .env (xem .env.example).");
  process.exit(1);
}
const IS_PROD=process.env.NODE_ENV==="production";
if(IS_PROD&&!process.env.SESSION_SECRET){console.error("❌ Cần đặt SESSION_SECRET khi chạy production.");process.exit(1);}
const db=createClient(SUPABASE_URL,SUPABASE_KEY,{auth:{persistSession:false,autoRefreshToken:false}});

/* ---------- helpers ---------- */
async function must(query){const {data,error}=await query;if(error)throw error;return data;}
const h=fn=>(req,res,next)=>Promise.resolve(fn(req,res,next)).catch(next);
const ok=(res,data)=>res.json({ok:true,...data});

async function month(){
  const d=new Date(),m=d.getMonth()+1,y=d.getFullYear();
  const found=await must(db.from("months").select("*").eq("month",m).eq("year",y).maybeSingle());
  if(found)return found;
  return must(db.from("months").upsert({month:m,year:y},{onConflict:"month,year"}).select().single());
}
async function scoreMap(monthId){
  const rows=await must(db.from("v_month_scores").select("*").eq("month_id",monthId));
  return new Map(rows.map(r=>[r.student_id,r]));
}
const sc=(map,id)=>{const r=map.get(id);return r?{total:r.total,plus:r.plus,minus:r.minus,records:r.records}:{total:0,plus:0,minus:0,records:0};};
const loadClasses=()=>must(db.from("classifications").select("*"));
const classify=(cls,t)=>cls.filter(c=>t>=c.min_score&&t<=c.max_score).sort((a,b)=>b.min_score-a.min_score)[0]?.name||"Chưa xếp";
const teamMapOf=async()=>new Map((await must(db.from("teams").select("id,name"))).map(t=>[t.id,t.name]));
const activeStudents=()=>must(db.from("students").select("*").eq("active",1).order("team_id").order("full_name"));

async function visibleStudent(req,id){
  const n=Number(id);if(!Number.isInteger(n))return null;
  const s=await must(db.from("students").select("*").eq("id",n).eq("active",1).maybeSingle());
  if(!s)return null;
  if(req.session.user.role==="TEAM_LEADER"&&s.team_id!==req.session.user.team_id)return null;
  return s;
}


/* ---------- session store lưu trong Supabase (dùng chung nhiều server, không mất khi restart) ---------- */
class SupabaseStore extends session.Store{
  get(sid,cb){
    db.from("sessions").select("sess,expire").eq("sid",sid).maybeSingle().then(({data,error})=>{
      if(error)return cb(error);
      if(!data||new Date(data.expire)<new Date())return cb(null,null);
      cb(null,data.sess);
    },cb);
  }
  set(sid,sess,cb){
    const expire=sess.cookie&&sess.cookie.expires?new Date(sess.cookie.expires):new Date(Date.now()+8*3600*1000);
    db.from("sessions").upsert({sid,sess,expire:expire.toISOString()}).then(({error})=>cb&&cb(error||null),e=>cb&&cb(e));
  }
  touch(sid,sess,cb){
    const expire=sess.cookie&&sess.cookie.expires?new Date(sess.cookie.expires):new Date(Date.now()+8*3600*1000);
    db.from("sessions").update({expire:expire.toISOString()}).eq("sid",sid).then(({error})=>cb&&cb(error||null),e=>cb&&cb(e));
  }
  destroy(sid,cb){db.from("sessions").delete().eq("sid",sid).then(({error})=>cb&&cb(error||null),e=>cb&&cb(e));}
}
setInterval(()=>db.from("sessions").delete().lt("expire",new Date().toISOString()).then(()=>{}),60*60*1000).unref();

/* ---------- giới hạn đăng nhập sai: 10 lần / 15 phút / IP ---------- */
const fails=new Map();
const WINDOW=15*60*1000,MAX_FAILS=10;
function tooMany(ip){const f=fails.get(ip);if(!f)return false;if(Date.now()-f.t>WINDOW){fails.delete(ip);return false;}return f.n>=MAX_FAILS;}
function addFail(ip){const f=fails.get(ip);if(!f||Date.now()-f.t>WINDOW)fails.set(ip,{n:1,t:Date.now()});else f.n++;}
setInterval(()=>{for(const [k,v] of fails)if(Date.now()-v.t>WINDOW)fails.delete(k);},WINDOW).unref();

/* ---------- seed ---------- */
async function seed(){
  const has=async t=>(await must(db.from(t).select("id").limit(1))).length>0;

  if(!(await has("users"))){
    let pw=process.env.ADMIN_PASSWORD;
    if(!pw){
      pw=IS_PROD?require("crypto").randomBytes(9).toString("base64url"):"admin123";
      console.log(`\n🔑 Tài khoản admin được tạo: admin / ${pw}  ${IS_PROD?"(chỉ hiện 1 lần, hãy lưu lại)":"(đổi trước khi công khai)"}\n`);
    }
    await must(db.from("users").insert({username:"admin",password_hash:bcrypt.hashSync(pw,10),full_name:"Quản trị viên",role:"ADMIN"}));
  }
  if(!(await has("teams"))){
    await must(db.from("teams").insert([1,2,3,4].map(i=>({name:"Tổ "+i}))));
  }
  if(!(await has("score_rules"))){
    await must(db.from("score_rules").insert([
      ["Phát biểu xây dựng bài","PLUS",2,"Có phát biểu xây dựng bài"],
      ["Giúp đỡ bạn","PLUS",2,"Hỗ trợ bạn học"],
      ["Hoàn thành nhiệm vụ","PLUS",3,"Hoàn thành tốt nhiệm vụ"],
      ["Đi học muộn","MINUS",2,"Đi học muộn"],
      ["Không làm bài","MINUS",3,"Không hoàn thành bài tập"],
      ["Không đồng phục","MINUS",2,"Không đúng đồng phục"],
      ["Vi phạm nội quy","MINUS",5,"Vi phạm nội quy lớp"]
    ].map(([name,type,points,description])=>({name,type,points,description}))));
  }
  if(!(await has("classifications"))){
    await must(db.from("classifications").insert([
      {min_score:90,max_score:999,name:"Tốt"},{min_score:80,max_score:89,name:"Khá"},
      {min_score:65,max_score:79,name:"Trung bình"},{min_score:-999,max_score:64,name:"Yếu"}
    ]));
  }
  const mo=await month();

  // Dữ liệu mẫu để Dashboard không bị trắng. Đặt SEED_DEMO=false để bỏ qua.
  if(process.env.SEED_DEMO!=="false"&&!(await has("students"))){
    const teams=await must(db.from("teams").select("id").order("id"));
    const names=[
      ["HS001","Nguyễn Minh Anh","Nữ"],["HS002","Trần Quốc Bảo","Nam"],["HS003","Lê Hoàng Nam","Nam"],
      ["HS004","Phạm Ngọc Mai","Nữ"],["HS005","Võ Thành Đạt","Nam"],["HS006","Đỗ Khánh Linh","Nữ"],
      ["HS007","Nguyễn Gia Huy","Nam"],["HS008","Trương Hà My","Nữ"],["HS009","Bùi Đức Long","Nam"],
      ["HS010","Hoàng Yến Nhi","Nữ"],["HS011","Phan Nhật Minh","Nam"],["HS012","Lâm Thảo Vy","Nữ"]
    ];
    const students=await must(db.from("students").insert(
      names.map((n,i)=>({student_code:n[0],full_name:n[1],gender:n[2],team_id:teams[i%4].id}))).select("id").order("id"));
    const admin=(await must(db.from("users").select("id").eq("username","admin").single())).id;
    const plus=await must(db.from("score_rules").select("*").eq("type","PLUS").order("id").limit(3));
    const minus=await must(db.from("score_rules").select("*").eq("type","MINUS").order("id").limit(4));
    const recs=[];
    students.forEach((s,i)=>{
      if(i%2===0){const r=plus[i%plus.length];recs.push({student_id:s.id,month_id:mo.id,rule_id:r.id,points:r.points,description:"Dữ liệu mẫu",recorded_by:admin});}
      if(i%3===0){const r=minus[i%minus.length];recs.push({student_id:s.id,month_id:mo.id,rule_id:r.id,points:-r.points,description:"Dữ liệu mẫu",recorded_by:admin});}
    });
    await must(db.from("score_records").insert(recs));
  }
}

/* ---------- middleware ---------- */
app.use(express.json());
app.use(express.urlencoded({extended:true}));
if(IS_PROD)app.set("trust proxy",1);
app.use(session({
  store:new SupabaseStore(),
  secret:process.env.SESSION_SECRET||"CHANGE_THIS_SECRET",
  resave:false,saveUninitialized:false,
  cookie:{httpOnly:true,sameSite:"lax",secure:IS_PROD,maxAge:8*60*60*1000}
}));
app.use(express.static("public"));

function auth(req,res,next){if(!req.session.user)return res.status(401).json({error:"Phiên đăng nhập đã hết hạn"});next();}
function pageAuth(req,res,next){if(!req.session.user)return res.redirect("/login");next();}
function role(...roles){return (req,res,next)=>{if(!req.session.user)return res.status(401).json({error:"Chưa đăng nhập"});if(!roles.includes(req.session.user.role))return res.status(403).json({error:"Bạn không có quyền thực hiện thao tác này"});next();};}

/* ---------- auth ---------- */
app.get("/login",(req,res)=>{if(req.session.user)return res.redirect("/");res.sendFile(__dirname+"/public/login.html")});
app.post("/login",h(async(req,res)=>{
  if(tooMany(req.ip))return res.status(429).send("Đăng nhập sai quá nhiều lần. Vui lòng thử lại sau 15 phút.");
  const u=await must(db.from("users").select("*").eq("username",(req.body.username||"").trim()).eq("active",1).maybeSingle());
  if(!u||!bcrypt.compareSync(req.body.password||"",u.password_hash)){addFail(req.ip);return res.redirect("/login?error=1");}
  fails.delete(req.ip);
  req.session.user={id:u.id,username:u.username,full_name:u.full_name,role:u.role,team_id:u.team_id};
  res.redirect("/");
}));
app.post("/logout",(req,res)=>req.session.destroy(()=>res.redirect("/login")));
app.get("/",pageAuth,(req,res)=>res.sendFile(__dirname+"/public/index.html"));
app.get("/api/me",auth,(req,res)=>ok(res,{user:req.session.user}));
app.get("/api/health",h(async(req,res)=>{await must(db.from("months").select("id").limit(1));ok(res,{message:"Server OK",db:"Supabase OK",time:new Date().toISOString()});}));

/* ---------- dashboard ---------- */
app.get("/api/dashboard",auth,h(async(req,res)=>{
  const u=req.session.user,mo=await month();
  const [all,teamRows,scores,cls]=await Promise.all([
    activeStudents(),must(db.from("teams").select("*").order("id")),scoreMap(mo.id),loadClasses()]);
  const tname=new Map(teamRows.map(t=>[t.id,t.name]));
  let students=all;
  if(u.role==="TEAM_LEADER")students=students.filter(s=>s.team_id===u.team_id);
  const rows=students.map(s=>{const x=sc(scores,s.id);return {...s,team_name:tname.get(s.team_id)||null,...x,classification:classify(cls,x.total)};});

  let violations=[];
  if(rows.length){
    violations=await must(db.from("score_records").select("id,student_id,points,description,created_at,recorded_by")
      .eq("month_id",mo.id).lt("points",0).in("student_id",rows.map(s=>s.id))
      .order("created_at",{ascending:false}).limit(8));
    const uids=[...new Set(violations.map(v=>v.recorded_by).filter(Boolean))];
    const users=uids.length?await must(db.from("users").select("id,full_name").in("id",uids)):[];
    const un=new Map(users.map(x=>[x.id,x.full_name])),sn=new Map(rows.map(s=>[s.id,s.full_name]));
    violations=violations.map(v=>({id:v.id,full_name:sn.get(v.student_id),points:v.points,description:v.description,created_at:v.created_at,recorder:un.get(v.recorded_by)||null}));
  }
  const teams=teamRows.map(t=>{
    const a=rows.filter(s=>s.team_id===t.id),total=a.reduce((n,s)=>n+s.total,0);
    return {...t,count:a.length,total,avg:a.length?Number((total/a.length).toFixed(1)):0};
  }).filter(t=>u.role!=="TEAM_LEADER"||t.id===u.team_id);
  ok(res,{month:mo,students:rows,teams,violations,stats:{
    students:rows.length,total:rows.reduce((n,s)=>n+s.total,0),
    plus:rows.reduce((n,s)=>n+s.plus,0),minus:rows.reduce((n,s)=>n+s.minus,0),
    violations:rows.reduce((n,s)=>n+s.records,0)}});
}));

/* ---------- students ---------- */
app.get("/api/students",auth,h(async(req,res)=>{
  const [all,tname]=await Promise.all([must(db.from("students").select("*").eq("active",1).order("full_name")),teamMapOf()]);
  let ss=all.map(s=>({...s,team_name:tname.get(s.team_id)||null}));
  if(req.session.user.role==="TEAM_LEADER")ss=ss.filter(s=>s.team_id===req.session.user.team_id);
  ok(res,{students:ss});
}));
app.post("/api/students",role("ADMIN","CLASS_LEADER"),h(async(req,res)=>{
  try{
    await must(db.from("students").insert({student_code:req.body.student_code.trim(),full_name:req.body.full_name.trim(),gender:req.body.gender||"",team_id:req.body.team_id||null}));
    ok(res);
  }catch(e){res.status(400).json({error:"Không thể thêm học sinh. Mã học sinh có thể đã tồn tại."});}
}));
app.put("/api/students/:id",role("ADMIN","CLASS_LEADER"),h(async(req,res)=>{
  const s=await must(db.from("students").select("id").eq("id",req.params.id).maybeSingle());
  if(!s)return res.status(404).json({error:"Không tìm thấy"});
  try{
    await must(db.from("students").update({student_code:req.body.student_code,full_name:req.body.full_name,gender:req.body.gender||"",team_id:req.body.team_id||null}).eq("id",s.id));
    ok(res);
  }catch(e){res.status(400).json({error:"Không thể cập nhật. Mã học sinh có thể đã tồn tại."});}
}));
app.delete("/api/students/:id",role("ADMIN","CLASS_LEADER"),h(async(req,res)=>{
  await must(db.from("students").update({active:0}).eq("id",req.params.id));ok(res);
}));

/* ---------- teams / rules ---------- */
app.get("/api/teams",auth,h(async(req,res)=>ok(res,{teams:await must(db.from("teams").select("*").order("id"))})));
app.post("/api/teams",role("ADMIN","CLASS_LEADER"),h(async(req,res)=>{
  try{await must(db.from("teams").insert({name:req.body.name.trim()}));ok(res);}
  catch(e){res.status(400).json({error:"Tên tổ đã tồn tại"});}
}));
app.get("/api/rules",auth,h(async(req,res)=>ok(res,{rules:await must(db.from("score_rules").select("*").order("type",{ascending:false}).order("id"))})));
app.post("/api/rules",role("ADMIN","CLASS_LEADER"),h(async(req,res)=>{
  await must(db.from("score_rules").insert({name:req.body.name,type:req.body.type,points:Math.abs(+req.body.points),description:req.body.description||""}));ok(res);
}));
app.delete("/api/rules/:id",role("ADMIN","CLASS_LEADER"),h(async(req,res)=>{
  await must(db.from("score_rules").delete().eq("id",req.params.id));ok(res);
}));

/* ---------- scores ---------- */
app.post("/api/scores",role("ADMIN","CLASS_LEADER","CLASS_VICE","TEAM_LEADER"),h(async(req,res)=>{
  const s=await visibleStudent(req,req.body.student_id);
  if(!s)return res.status(403).json({error:"Không tìm thấy học sinh hoặc bạn không quản lý học sinh này"});
  const rid=Number(req.body.rule_id);
  const r=Number.isInteger(rid)?await must(db.from("score_rules").select("*").eq("id",rid).maybeSingle()):null;
  if(!r)return res.status(400).json({error:"Quy tắc không tồn tại"});
  const mo=await month(),p=r.type==="PLUS"?Math.abs(r.points):-Math.abs(r.points);
  await must(db.from("score_records").insert({student_id:s.id,month_id:mo.id,rule_id:r.id,points:p,description:req.body.description||r.description,recorded_by:req.session.user.id}));
  ok(res);
}));
app.get("/api/records/:id",auth,h(async(req,res)=>{
  const s=await visibleStudent(req,req.params.id);
  if(!s)return res.status(403).json({error:"Không có quyền"});
  const mo=await month();
  const recs=await must(db.from("score_records").select("*").eq("student_id",s.id).eq("month_id",mo.id).order("created_at",{ascending:false}));
  const [rules,users]=await Promise.all([must(db.from("score_rules").select("id,name")),must(db.from("users").select("id,full_name"))]);
  const rn=new Map(rules.map(x=>[x.id,x.name])),un=new Map(users.map(x=>[x.id,x.full_name]));
  ok(res,{records:recs.map(r=>({...r,rule_name:rn.get(r.rule_id)||null,recorder:un.get(r.recorded_by)||null}))});
}));

/* ---------- users ---------- */
app.get("/api/users",role("ADMIN"),h(async(req,res)=>ok(res,{users:await must(db.from("users").select("id,username,full_name,role,team_id,active").order("id"))})));
app.post("/api/users",role("ADMIN"),h(async(req,res)=>{
  try{
    await must(db.from("users").insert({username:req.body.username.trim(),password_hash:bcrypt.hashSync(req.body.password,10),full_name:req.body.full_name.trim(),role:req.body.role,team_id:req.body.team_id||null}));
    ok(res);
  }catch(e){res.status(400).json({error:"Không thể tạo tài khoản. Tên đăng nhập có thể đã tồn tại."});}
}));
app.patch("/api/users/:id/toggle",role("ADMIN"),h(async(req,res)=>{
  const u=await must(db.from("users").select("id,active").eq("id",req.params.id).maybeSingle());
  if(!u)return res.status(404).json({error:"Không tìm thấy"});
  await must(db.from("users").update({active:u.active?0:1}).eq("id",u.id));ok(res);
}));

/* ---------- classifications ---------- */
app.get("/api/classifications",auth,h(async(req,res)=>ok(res,{items:await must(db.from("classifications").select("*").order("min_score",{ascending:false}))})));
app.post("/api/classifications",role("ADMIN","CLASS_LEADER"),h(async(req,res)=>{
  await must(db.from("classifications").insert({min_score:+req.body.min_score,max_score:+req.body.max_score,name:req.body.name}));ok(res);
}));

/* ---------- export ---------- */
async function exportRows(){
  const mo=await month();
  const [ss,tname,scores,cls]=await Promise.all([activeStudents(),teamMapOf(),scoreMap(mo.id),loadClasses()]);
  return {mo,rows:ss.map(s=>{const x=sc(scores,s.id);return {...s,team_name:tname.get(s.team_id)||"",...x,cls:classify(cls,x.total)};})};
}
app.get("/export/excel",role("ADMIN","CLASS_LEADER","CLASS_VICE"),h(async(req,res)=>{
  const {mo,rows}=await exportRows(),wb=new ExcelJS.Workbook(),ws=wb.addWorksheet("Thi đua");
  ws.mergeCells("A1:I1");ws.getCell("A1").value=`BẢNG THI ĐUA THÁNG ${mo.month}/${mo.year}`;ws.getCell("A1").font={bold:true,size:16};
  ws.addRow(["STT","Họ tên","Mã HS","Tổ","Điểm cộng","Điểm trừ","Tổng","Xếp loại","Hạnh kiểm"]);
  rows.forEach((s,i)=>ws.addRow([i+1,s.full_name,s.student_code,s.team_name,s.plus,s.minus,s.total,s.cls,s.cls]));
  ws.getRow(2).font={bold:true};ws.columns.forEach(c=>c.width=20);
  res.setHeader("Content-Type","application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  res.setHeader("Content-Disposition",`attachment; filename="thi-dua-${mo.month}-${mo.year}.xlsx"`);
  await wb.xlsx.write(res);res.end();
}));
app.get("/export/word",role("ADMIN","CLASS_LEADER","CLASS_VICE"),h(async(req,res)=>{
  const {mo,rows:data}=await exportRows();
  const cells=t=>new TableCell({children:[new Paragraph({children:[new TextRun({text:String(t),bold:true})]})]});
  const rows=[new TableRow({children:["STT","Họ tên","Tổ","Cộng","Trừ","Tổng","Xếp loại"].map(cells)})];
  data.forEach((s,i)=>rows.push(new TableRow({children:[i+1,s.full_name,s.team_name,s.plus,s.minus,s.total,s.cls].map(v=>new TableCell({children:[new Paragraph(String(v))]}))})));
  const doc=new Document({sections:[{properties:{},children:[
    new Paragraph({alignment:AlignmentType.CENTER,children:[new TextRun({text:`BẢNG THI ĐUA THÁNG ${mo.month}/${mo.year}`,bold:true,size:30})]}),
    new Paragraph({alignment:AlignmentType.CENTER,children:[new TextRun({text:"CLASS MANAGER",bold:true})]}),
    new Table({rows,width:{size:100,type:WidthType.PERCENTAGE}})
  ]}]});
  res.setHeader("Content-Type","application/vnd.openxmlformats-officedocument.wordprocessingml.document");
  res.setHeader("Content-Disposition",`attachment; filename="thi-dua-${mo.month}-${mo.year}.docx"`);
  res.end(await Packer.toBuffer(doc));
}));

app.use((err,req,res,next)=>{console.error(err);if(!res.headersSent)res.status(500).json({error:"Lỗi máy chủ",detail:process.env.NODE_ENV==="development"?err.message:undefined})});

seed().then(()=>app.listen(PORT,()=>console.log(`\n🌿 CLASS MANAGER v2 (Supabase) running: http://localhost:${PORT}\n`)))
  .catch(e=>{console.error("❌ Không kết nối/khởi tạo được Supabase. Đã chạy supabase/schema.sql chưa?\n",e.message||e);process.exit(1);});
