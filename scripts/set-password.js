// Dùng: npm run set-password -- <username> <mật_khẩu_mới>
require("dotenv").config();
const bcrypt=require("bcryptjs");
const {createClient}=require("@supabase/supabase-js");
const [,, username, password]=process.argv;
if(!username||!password||password.length<8){console.error("Dùng: npm run set-password -- <username> <mật_khẩu_mới (>=8 ký tự)>");process.exit(1);}
const db=createClient(process.env.SUPABASE_URL,process.env.SUPABASE_SERVICE_ROLE_KEY,{auth:{persistSession:false}});
(async()=>{
  const {data,error}=await db.from("users").update({password_hash:bcrypt.hashSync(password,10)}).eq("username",username).select("id");
  if(error){console.error(error.message);process.exit(1);}
  console.log(data.length?`✅ Đã đổi mật khẩu cho "${username}".`:`❌ Không tìm thấy tài khoản "${username}".`);
})();
