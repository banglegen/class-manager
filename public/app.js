/* ===================== Quản lý lớp - frontend ===================== */
const $ = (s) => document.querySelector(s);
const ROLE = { ADMIN: "Admin", CLASS_LEADER: "Lớp trưởng", CLASS_VICE: "Lớp phó", TEAM_LEADER: "Tổ trưởng" };
const state = { me: null, months: [], monthId: null, page: "dashboard", students: [], teams: [] };

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const can = (...roles) => roles.includes(state.me.role);
const fmtTime = (t) => new Date(t).toLocaleString("vi-VN", { hour12: false });
const withMonth = (url) => (state.monthId ? url + (url.includes("?") ? "&" : "?") + "month_id=" + state.monthId : url);
const isCurrent = () => {
  if (!state.monthId) return true;
  const m = state.months.find((x) => x.id === state.monthId);
  return !m || m.current;
};
const clsBadge = (c) => {
  const k = { "Tốt": "good", "Khá": "fine", "Trung bình": "mid", "Yếu": "bad" }[c] || "";
  return `<span class="badge ${k}">${esc(c)}</span>`;
};

async function api(url, opt = {}) {
  const o = { credentials: "same-origin", ...opt };
  if (o.body && typeof o.body !== "string") {
    o.body = JSON.stringify(o.body);
    o.headers = { "Content-Type": "application/json", ...(o.headers || {}) };
  }
  const r = await fetch(url, o);
  if (r.status === 401) { location.href = "/login"; throw new Error("Phiên đăng nhập đã hết hạn."); }
  let d = {};
  try { d = await r.json(); } catch (e) { /* ignore */ }
  if (!r.ok || d.ok === false) throw new Error(d.error || "Có lỗi xảy ra.");
  return d;
}
const formData = (form) => Object.fromEntries(new FormData(form).entries());

function toast(msg, bad = false) {
  const el = document.createElement("div");
  el.className = "toast" + (bad ? " bad" : "");
  el.textContent = msg;
  $("#toasts").appendChild(el);
  setTimeout(() => el.classList.add("hide"), 2600);
  setTimeout(() => el.remove(), 3100);
}

/* ------------------------------ modal ------------------------------ */
function openModal(title, html, onSubmit, submitLabel = "Lưu") {
  const m = $("#modal");
  m.innerHTML = `<div class="modal-box">
    <div class="modal-head"><h3>${esc(title)}</h3><button type="button" class="x" onclick="closeModal()">×</button></div>
    <form id="modalForm" class="modal-form">${html}
      <div class="modal-actions">
        <button type="button" class="btn ghost" onclick="closeModal()">Hủy</button>
        <button class="btn primary">${esc(submitLabel)}</button>
      </div>
    </form></div>`;
  m.classList.add("show");
  const form = $("#modalForm");
  const first = form.querySelector("input,select,textarea");
  if (first) first.focus();
  form.onsubmit = async (e) => {
    e.preventDefault();
    const btn = form.querySelector(".btn.primary");
    btn.disabled = true;
    try { await onSubmit(formData(form)); closeModal(); }
    catch (x) { toast(x.message, true); btn.disabled = false; }
  };
}
function closeModal() { const m = $("#modal"); m.classList.remove("show"); m.innerHTML = ""; }
document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeModal(); });
$("#modal").addEventListener("mousedown", (e) => { if (e.target.id === "modal") closeModal(); });

/* ------------------------------ layout ------------------------------ */
const PAGES = [
  ["dashboard", "🏠 Tổng quan", () => true],
  ["students", "🎓 Học sinh", () => true],
  ["scores", "⭐ Ghi điểm", () => true],
  ["records", "📜 Nhật ký điểm", () => true],
  ["teams", "👥 Các tổ", () => true],
  ["conduct", "📝 Hạnh kiểm", () => true],
  ["rules", "⚙️ Quy tắc & cài đặt", () => can("ADMIN")],
  ["users", "🔐 Tài khoản", () => can("ADMIN")]
];
const TITLES = Object.fromEntries(PAGES.map(([k, t]) => [k, t.replace(/^\S+\s/, "")]));

function buildNav() {
  $("#nav").innerHTML = PAGES.filter(([, , ok]) => ok())
    .map(([p, t]) => `<button type="button" data-page="${p}" onclick="navigate('${p}')">${t}</button>`).join("");
}

function buildMonthSelect() {
  const sel = $("#monthSel");
  sel.innerHTML = state.months.map((m) =>
    `<option value="${m.id}" ${(state.monthId ? m.id === state.monthId : m.current) ? "selected" : ""}>Tháng ${m.month}/${m.year}${m.current ? " (hiện tại)" : ""}</option>`).join("");
}
function buildExports() {
  $("#exports").innerHTML = can("ADMIN", "CLASS_LEADER", "CLASS_VICE")
    ? `<a class="btn ghost" href="${withMonth("/api/export.xlsx")}">⬇ Excel</a> <a class="btn ghost" href="${withMonth("/api/export.docx")}">⬇ Word</a>` : "";
}
function changeMonth(v) {
  const m = state.months.find((x) => x.id === Number(v));
  state.monthId = m && m.current ? null : Number(v);
  navigate(state.page);
}

async function navigate(page) {
  state.page = page;
  document.querySelectorAll("#nav button").forEach((b) => b.classList.toggle("active", b.dataset.page === page));
  $("#title").textContent = TITLES[page];
  $("#subtitle").textContent = "Dữ liệu dùng chung online";
  buildExports();
  $("#content").innerHTML = '<div class="loading">Đang tải...</div>';
  try { await PAGE_FN[page](); }
  catch (e) { $("#content").innerHTML = `<div class="error-box">${esc(e.message)}</div>`; }
}
const monthNotice = () => isCurrent() ? "" :
  '<div class="notice">📅 Bạn đang xem tháng cũ — chỉ xem, không thể chỉnh sửa hạnh kiểm. Chọn "(hiện tại)" ở góc phải để quay lại.</div>';

/* ------------------------------ dashboard ------------------------------ */
async function dashboard() {
  const d = await api(withMonth("/api/dashboard"));
  $("#subtitle").textContent = `Tháng ${d.month.month}/${d.month.year} · Điểm gốc ${d.base}`;
  const maxAvg = Math.max(1, ...d.teams.map((t) => t.avg));
  const ranked = [...d.students].sort((a, b) => b.total - a.total || a.full_name.localeCompare(b.full_name, "vi"));
  $("#content").innerHTML = `${monthNotice()}
  <div class="stat-grid">
    <div class="stat"><div class="icon">🎓</div><div><b>${d.stats.students}</b><span>Học sinh</span></div></div>
    <div class="stat"><div class="icon">👥</div><div><b>${d.stats.teams}</b><span>Tổ</span></div></div>
    <div class="stat"><div class="icon">⭐</div><div><b>${d.stats.avg}</b><span>Điểm trung bình</span></div></div>
    <div class="stat"><div class="icon">⚠️</div><div><b>${d.stats.violations}</b><span>Lượt vi phạm</span></div></div>
  </div>
  <div class="two-col">
    <div class="panel"><div class="panel-head"><h2>🏆 Thi đua các tổ</h2><span>Điểm trung bình</span></div>
      ${d.teams.map((t, i) => `<div class="team-row">
        <div class="rank">${i < 3 ? ["🥇", "🥈", "🥉"][i] : i + 1}</div>
        <div class="team-info"><b>${esc(t.name)}</b><small>${t.count} học sinh</small>
          <div class="bar"><i style="width:${Math.max(4, Math.round(t.avg / maxAvg * 100))}%"></i></div></div>
        <div class="team-score"><b>${t.avg}</b><small>${t.total} tổng</small></div></div>`).join("") || '<div class="empty">Chưa có tổ.</div>'}
    </div>
    <div class="panel"><div class="panel-head"><h2>⚠️ Vi phạm gần đây</h2><button type="button" class="text-btn" onclick="navigate('records')">Xem tất cả →</button></div>
      ${d.violations.map((v) => `<div class="violation-row"><div class="v-icon">!</div>
        <div><b>${esc(v.full_name)}</b><p>${esc(v.description || v.rule_name || "Vi phạm")}</p></div><strong>${v.points}</strong></div>`).join("")
        || '<div class="empty">🎉 Chưa có vi phạm.</div>'}
    </div>
  </div>
  <div class="panel"><div class="panel-head"><h2>📋 Bảng xếp hạng cá nhân</h2><span>${ranked.length} học sinh</span></div>
    <div class="table-wrap"><table><thead><tr><th>#</th><th>Học sinh</th><th>Tổ</th><th>Cộng</th><th>Trừ</th><th>Tổng</th><th>Xếp loại</th><th>Hạnh kiểm</th></tr></thead>
    <tbody>${ranked.map((s, i) => `<tr><td>${i + 1}</td><td><b>${esc(s.full_name)}</b><small>${esc(s.student_code)}</small></td>
      <td>${esc(s.team_name || "-")}</td><td class="plus">+${s.plus}</td><td class="minus">-${s.minus}</td><td><b>${s.total}</b></td>
      <td>${clsBadge(s.classification)}</td><td><span class="badge">${esc(s.conduct)}</span></td></tr>`).join("")
      || '<tr><td colspan="8" class="empty">Chưa có học sinh. Vào mục Học sinh để thêm.</td></tr>'}</tbody></table></div></div>`;
}

/* ------------------------------ students ------------------------------ */
const canEditStudents = () => can("ADMIN", "CLASS_LEADER");
async function students() {
  const [a, b] = await Promise.all([api("/api/students"), api("/api/teams")]);
  state.students = a.students; state.teams = b.teams;
  const teamOpts = (sel) => '<option value="">Chưa có tổ</option>' +
    b.teams.map((t) => `<option value="${t.id}" ${Number(sel) === t.id ? "selected" : ""}>${esc(t.name)}</option>`).join("");
  state.teamOpts = teamOpts;
  $("#content").innerHTML = `
  ${canEditStudents() ? `<div class="panel"><div class="panel-head"><h2>➕ Thêm học sinh</h2>
      <button type="button" class="text-btn" onclick="importStudents()">📥 Nhập nhiều học sinh</button></div>
    <form class="form" onsubmit="addStudent(event)">
      <input name="student_code" placeholder="Mã học sinh" required>
      <input name="full_name" placeholder="Họ và tên" required>
      <select name="gender"><option>Nam</option><option>Nữ</option></select>
      <select name="team_id">${teamOpts("")}</select>
      <button class="btn primary">Thêm học sinh</button></form></div>` : ""}
  <div class="panel"><div class="panel-head"><h2>🎓 Danh sách học sinh</h2>
    <input id="stuSearch" class="search" placeholder="🔍 Tìm theo tên hoặc mã..." oninput="renderStudentRows()"></div>
    <div class="table-wrap"><table><thead><tr><th>Mã</th><th>Họ tên</th><th>Giới tính</th><th>Tổ</th><th></th></tr></thead>
    <tbody id="stuRows"></tbody></table></div></div>`;
  renderStudentRows();
}
function renderStudentRows() {
  const k = ($("#stuSearch")?.value || "").trim().toLowerCase();
  const list = state.students.filter((s) => !k || s.full_name.toLowerCase().includes(k) || s.student_code.toLowerCase().includes(k));
  $("#stuRows").innerHTML = list.map((s) => `<tr><td>${esc(s.student_code)}</td><td><b>${esc(s.full_name)}</b></td>
    <td>${esc(s.gender || "-")}</td><td>${esc(s.team_name || "-")}</td>
    <td class="actions">${canEditStudents() ? `<button type="button" class="ghost-btn" onclick="editStudent(${s.id})">Sửa</button>
      <button type="button" class="danger-btn" onclick="removeStudent(${s.id})">Xóa</button>` : ""}</td></tr>`).join("")
    || '<tr><td colspan="5" class="empty">Không có học sinh nào.</td></tr>';
}
async function addStudent(e) {
  e.preventDefault();
  try {
    await api("/api/students", { method: "POST", body: formData(e.target) });
    toast("Đã thêm học sinh"); students();
  } catch (x) { toast(x.message, true); }
}
function editStudent(id) {
  const s = state.students.find((x) => x.id === id);
  if (!s) return;
  openModal("Sửa học sinh", `
    <label>Mã học sinh</label><input name="student_code" value="${esc(s.student_code)}" required>
    <label>Họ và tên</label><input name="full_name" value="${esc(s.full_name)}" required>
    <label>Giới tính</label><select name="gender"><option ${s.gender === "Nam" ? "selected" : ""}>Nam</option><option ${s.gender === "Nữ" ? "selected" : ""}>Nữ</option></select>
    <label>Tổ</label><select name="team_id">${state.teamOpts(s.team_id)}</select>`,
  async (v) => { await api("/api/students/" + id, { method: "PUT", body: v }); toast("Đã cập nhật"); students(); });
}
async function removeStudent(id) {
  if (!confirm("Ẩn học sinh này khỏi danh sách? (Lịch sử điểm vẫn được giữ)")) return;
  try { await api("/api/students/" + id, { method: "DELETE" }); toast("Đã xóa"); students(); }
  catch (x) { toast(x.message, true); }
}
function importStudents() {
  openModal("Nhập nhiều học sinh", `
    <p class="hint">Mỗi dòng một học sinh, định dạng:<br><code>Mã, Họ tên, Giới tính, Tổ</code><br>Ví dụ: <code>HS013, Nguyễn Văn An, Nam, Tổ 1</code> (giới tính và tổ có thể bỏ trống)</p>
    <textarea name="text" rows="9" placeholder="HS013, Nguyễn Văn An, Nam, Tổ 1&#10;HS014, Trần Thị Bình, Nữ, 2" required></textarea>`,
  async (v) => {
    const r = await api("/api/students/import", { method: "POST", body: v });
    toast(`Đã thêm ${r.added}, bỏ qua ${r.skipped} (trùng mã)${r.errors.length ? ", lỗi " + r.errors.length + " dòng" : ""}`, r.errors.length > 0);
    students();
  }, "Nhập");
}

/* ------------------------------ scores ------------------------------ */
async function scores() {
  const [a, b, r] = await Promise.all([api("/api/students"), api("/api/rules"), api("/api/records")]);
  const groups = {};
  a.students.forEach((s) => (groups[s.team_name || "Chưa có tổ"] ||= []).push(s));
  const stuOpts = Object.entries(groups).map(([g, list]) =>
    `<optgroup label="${esc(g)}">${list.map((s) => `<option value="${s.id}">${esc(s.full_name)} (${esc(s.student_code)})</option>`).join("")}</optgroup>`).join("");
  const ruleOpts = ["PLUS", "MINUS"].map((t) =>
    `<optgroup label="${t === "PLUS" ? "➕ Điểm cộng" : "➖ Điểm trừ"}">${b.rules.filter((x) => x.type === t)
      .map((x) => `<option value="${x.id}">${esc(x.name)} (${t === "PLUS" ? "+" : "-"}${x.points})</option>`).join("")}</optgroup>`).join("");
  $("#content").innerHTML = `
  <div class="panel"><div class="panel-head"><h2>⭐ Ghi nhận điểm</h2><span>Lưu vào tháng hiện tại</span></div>
    ${a.students.length ? `<form class="form" onsubmit="addScore(event)">
      <select name="student_id" required>${stuOpts}</select>
      <select name="rule_id" required>${ruleOpts}</select>
      <input name="description" placeholder="Nội dung chi tiết (tùy chọn)">
      <button class="btn primary">💾 Lưu điểm</button></form>`
      : '<div class="empty">Chưa có học sinh để ghi điểm.</div>'}</div>
  <div class="panel"><div class="panel-head"><h2>🕒 Ghi gần đây</h2></div>${recordTable(r.records.slice(0, 10), false)}</div>
  <div class="panel"><div class="panel-head"><h2>📌 Quy tắc điểm</h2></div><div class="rule-grid">
    ${b.rules.map((x) => `<div class="rule ${x.type === "PLUS" ? "" : "minus"}"><b>${x.type === "PLUS" ? "➕" : "➖"} ${esc(x.name)}</b>
      <strong>${x.type === "PLUS" ? "+" : "-"}${x.points}</strong><small>${esc(x.description || "")}</small></div>`).join("")}</div></div>`;
}
async function addScore(e) {
  e.preventDefault();
  const form = e.target;
  try {
    await api("/api/scores", { method: "POST", body: formData(form) });
    toast("Đã ghi nhận điểm");
    const keep = { s: form.student_id.value, r: form.rule_id.value };
    await scores();
    const f = $("#content form");
    if (f) { f.student_id.value = keep.s; f.rule_id.value = keep.r; }
  } catch (x) { toast(x.message, true); }
}

/* ------------------------------ records ------------------------------ */
function recordTable(rows, withDelete) {
  const del = withDelete && can("ADMIN", "CLASS_LEADER", "CLASS_VICE");
  return `<div class="table-wrap"><table><thead><tr><th>Học sinh</th><th>Tổ</th><th>Điểm</th><th>Quy tắc</th><th>Nội dung</th><th>Người ghi</th><th>Thời gian</th>${del ? "<th></th>" : ""}</tr></thead>
  <tbody>${rows.map((v) => `<tr><td><b>${esc(v.full_name)}</b></td><td>${esc(v.team_name || "-")}</td>
    <td class="${v.points > 0 ? "plus" : "minus"}">${v.points > 0 ? "+" : ""}${v.points}</td><td>${esc(v.rule_name || "-")}</td>
    <td>${esc(v.description || "")}</td><td>${esc(v.recorder || "")}</td><td>${fmtTime(v.created_at)}</td>
    ${del ? `<td><button type="button" class="danger-btn" onclick="deleteRecord(${v.id})">Xóa</button></td>` : ""}</tr>`).join("")
    || `<tr><td colspan="${del ? 8 : 7}" class="empty">Chưa có dữ liệu.</td></tr>`}</tbody></table></div>`;
}
async function records(type = "all") {
  const d = await api(withMonth("/api/records?type=" + type));
  $("#subtitle").textContent = `Tháng ${d.month.month}/${d.month.year}`;
  $("#content").innerHTML = `${monthNotice()}<div class="panel"><div class="panel-head"><h2>📜 Nhật ký điểm</h2>
    <select onchange="records(this.value)">
      <option value="all" ${type === "all" ? "selected" : ""}>Tất cả</option>
      <option value="minus" ${type === "minus" ? "selected" : ""}>Chỉ vi phạm (trừ)</option>
      <option value="plus" ${type === "plus" ? "selected" : ""}>Chỉ cộng điểm</option></select></div>
    ${recordTable(d.records, true)}</div>`;
}
async function deleteRecord(id) {
  if (!confirm("Xóa bản ghi điểm này? Điểm của học sinh sẽ được tính lại.")) return;
  try { await api("/api/records/" + id, { method: "DELETE" }); toast("Đã xóa"); records($("#content select").value); }
  catch (x) { toast(x.message, true); }
}

/* ------------------------------ teams ------------------------------ */
async function teams() {
  const d = await api(withMonth("/api/dashboard"));
  const admin = can("ADMIN");
  state.teamStats = d.teams;
  $("#subtitle").textContent = `Tháng ${d.month.month}/${d.month.year}`;
  $("#content").innerHTML = `${monthNotice()}
  ${admin ? `<div class="panel"><div class="panel-head"><h2>➕ Thêm tổ</h2></div>
    <form class="form form-inline" onsubmit="addTeam(event)"><input name="name" placeholder="Tên tổ, ví dụ: Tổ 5" required><button class="btn primary">Thêm tổ</button></form></div>` : ""}
  <div class="stat-grid">${d.teams.map((t, i) => `<div class="team-card">
    <div class="team-big">${i < 3 ? ["🥇", "🥈", "🥉"][i] : "👥"}</div><h2>${esc(t.name)}</h2><p>${t.count} học sinh</p>
    <b>${t.avg} điểm trung bình</b><small>${t.total} tổng · +${t.plus} / -${t.minus}</small>
    ${admin ? `<div class="actions"><button type="button" class="ghost-btn" onclick="renameTeam(${t.id})">Đổi tên</button>
      <button type="button" class="danger-btn" onclick="deleteTeam(${t.id})">Xóa</button></div>` : ""}</div>`).join("")
      || '<div class="panel"><div class="empty">Chưa có tổ nào.</div></div>'}</div>`;
}
async function addTeam(e) {
  e.preventDefault();
  try { await api("/api/teams", { method: "POST", body: formData(e.target) }); toast("Đã thêm tổ"); teams(); }
  catch (x) { toast(x.message, true); }
}
function renameTeam(id) {
  const t = state.teamStats.find((x) => x.id === id);
  if (!t) return;
  openModal("Đổi tên tổ", `<label>Tên tổ</label><input name="name" value="${esc(t.name)}" required>`,
    async (v) => { await api("/api/teams/" + id, { method: "PUT", body: v }); toast("Đã đổi tên"); teams(); });
}
async function deleteTeam(id) {
  if (!confirm("Xóa tổ này? Học sinh và tổ trưởng thuộc tổ sẽ chuyển thành chưa có tổ.")) return;
  try { await api("/api/teams/" + id, { method: "DELETE" }); toast("Đã xóa tổ"); teams(); }
  catch (x) { toast(x.message, true); }
}

/* ------------------------------ conduct ------------------------------ */
async function conduct() {
  const d = await api(withMonth("/api/dashboard"));
  const edit = can("ADMIN", "CLASS_LEADER", "CLASS_VICE") && d.is_current;
  $("#subtitle").textContent = `Tháng ${d.month.month}/${d.month.year}`;
  const opt = (cur, v) => `<option ${cur === v ? "selected" : ""}>${v}</option>`;
  $("#content").innerHTML = `${monthNotice()}
  ${!can("ADMIN", "CLASS_LEADER", "CLASS_VICE") ? '<div class="notice">Bạn chỉ có quyền xem hạnh kiểm.</div>' : ""}
  <div class="panel"><div class="panel-head"><h2>📝 Hạnh kiểm tháng ${d.month.month}/${d.month.year}</h2><span>${d.students.length} học sinh</span></div>
  <div class="table-wrap"><table><thead><tr><th>Học sinh</th><th>Tổ</th><th>Tổng điểm</th><th>Xếp loại</th><th>Hạnh kiểm</th><th>Ghi chú</th>${edit ? "<th></th>" : ""}</tr></thead>
  <tbody>${d.students.map((s) => `<tr data-id="${s.id}"><td><b>${esc(s.full_name)}</b></td><td>${esc(s.team_name || "-")}</td><td>${s.total}</td><td>${clsBadge(s.classification)}</td>
    ${edit ? `<td><select class="c-rating"><option ${s.conduct === "Chưa xếp" ? "selected" : ""} value="">Chưa xếp</option>${["Tốt", "Khá", "Trung bình", "Yếu"].map((v) => opt(s.conduct, v)).join("")}</select></td>
      <td><input class="c-note" value="${esc(s.conduct_note)}" placeholder="Nhận xét"></td>
      <td><button type="button" class="btn primary sm" onclick="saveConduct(${s.id}, this)">Lưu</button></td>`
      : `<td><span class="badge">${esc(s.conduct)}</span></td><td>${esc(s.conduct_note)}</td>`}</tr>`).join("")
      || '<tr><td colspan="7" class="empty">Chưa có học sinh.</td></tr>'}</tbody></table></div></div>`;
}
async function saveConduct(id, btn) {
  const tr = btn.closest("tr");
  const rating = tr.querySelector(".c-rating").value;
  if (!rating) return toast("Hãy chọn xếp loại hạnh kiểm.", true);
  btn.disabled = true;
  try {
    await api("/api/conduct", { method: "POST", body: { student_id: id, rating, note: tr.querySelector(".c-note").value } });
    toast("Đã lưu hạnh kiểm");
  } catch (x) { toast(x.message, true); }
  btn.disabled = false;
}

/* ------------------------------ rules & settings ------------------------------ */
async function rules() {
  const [a, s] = await Promise.all([api("/api/rules"), api("/api/settings")]);
  $("#content").innerHTML = `
  <div class="panel"><div class="panel-head"><h2>🎯 Điểm gốc mỗi tháng</h2><span>Xếp loại: Tốt ≥ 90 · Khá ≥ 80 · Trung bình ≥ 65 · Yếu &lt; 65</span></div>
    <form class="form form-inline" onsubmit="saveBase(event)"><input name="base_score" type="number" min="0" max="1000" value="${s.base_score}" required>
    <button class="btn primary">Lưu điểm gốc</button></form></div>
  <div class="panel"><div class="panel-head"><h2>➕ Thêm quy tắc điểm</h2></div>
    <form class="form" onsubmit="addRule(event)">
      <input name="name" placeholder="Tên quy tắc" required>
      <select name="type"><option value="PLUS">Điểm cộng</option><option value="MINUS">Điểm trừ</option></select>
      <input name="points" type="number" min="1" placeholder="Số điểm" required>
      <input name="description" placeholder="Mô tả (tùy chọn)">
      <button class="btn primary">Thêm</button></form></div>
  <div class="panel"><div class="table-wrap"><table><thead><tr><th>Quy tắc</th><th>Loại</th><th>Điểm</th><th>Mô tả</th><th></th></tr></thead>
  <tbody>${a.rules.map((r) => `<tr><td><b>${esc(r.name)}</b></td><td>${r.type === "PLUS" ? "Cộng" : "Trừ"}</td>
    <td class="${r.type === "PLUS" ? "plus" : "minus"}">${r.type === "PLUS" ? "+" : "-"}${r.points}</td><td>${esc(r.description || "")}</td>
    <td><button type="button" class="danger-btn" onclick="deleteRule(${r.id})">Xóa</button></td></tr>`).join("")}</tbody></table></div></div>`;
}
async function saveBase(e) {
  e.preventDefault();
  try { await api("/api/settings", { method: "PUT", body: formData(e.target) }); toast("Đã lưu điểm gốc"); }
  catch (x) { toast(x.message, true); }
}
async function addRule(e) {
  e.preventDefault();
  try { await api("/api/rules", { method: "POST", body: formData(e.target) }); toast("Đã thêm quy tắc"); rules(); }
  catch (x) { toast(x.message, true); }
}
async function deleteRule(id) {
  if (!confirm("Xóa quy tắc này? Các bản ghi điểm cũ vẫn được giữ.")) return;
  try { await api("/api/rules/" + id, { method: "DELETE" }); toast("Đã xóa"); rules(); }
  catch (x) { toast(x.message, true); }
}

/* ------------------------------ users ------------------------------ */
async function users() {
  const [a, b] = await Promise.all([api("/api/users"), api("/api/teams")]);
  state.users = a.users; state.teams = b.teams;
  const teamOpts = (sel) => '<option value="">Không gán tổ</option>' +
    b.teams.map((t) => `<option value="${t.id}" ${Number(sel) === t.id ? "selected" : ""}>${esc(t.name)}</option>`).join("");
  state.userTeamOpts = teamOpts;
  const roleOpts = (sel) => Object.entries(ROLE).map(([k, v]) => `<option value="${k}" ${sel === k ? "selected" : ""}>${v}</option>`).join("");
  state.roleOpts = roleOpts;
  $("#content").innerHTML = `
  <div class="panel"><div class="panel-head"><h2>🔐 Tạo tài khoản</h2><span>Tổ trưởng cần chọn tổ</span></div>
    <form class="form form-6" onsubmit="addUser(event)">
      <input name="username" placeholder="Tên đăng nhập" required autocomplete="off">
      <input name="password" type="password" minlength="6" placeholder="Mật khẩu ≥ 6 ký tự" required autocomplete="new-password">
      <input name="full_name" placeholder="Họ tên" required>
      <select name="role">${roleOpts("CLASS_LEADER")}</select>
      <select name="team_id">${teamOpts("")}</select>
      <button class="btn primary">Tạo tài khoản</button></form></div>
  <div class="panel"><div class="table-wrap"><table><thead><tr><th>Tài khoản</th><th>Họ tên</th><th>Quyền</th><th>Tổ</th><th>Trạng thái</th><th></th></tr></thead>
  <tbody>${a.users.map((u) => `<tr><td><b>${esc(u.username)}</b></td><td>${esc(u.full_name)}</td><td><span class="badge">${ROLE[u.role]}</span></td>
    <td>${esc(u.team_name || "-")}</td><td>${u.active ? "🟢 Hoạt động" : "🔴 Đã khóa"}</td>
    <td class="actions"><button type="button" class="ghost-btn" onclick="editUser(${u.id})">Sửa</button>
      <button type="button" class="ghost-btn" onclick="resetPassword(${u.id})">Đặt lại MK</button>
      ${u.id !== state.me.id ? `<button type="button" class="danger-btn" onclick="toggleUser(${u.id})">${u.active ? "Khóa" : "Mở"}</button>` : ""}</td></tr>`).join("")}
  </tbody></table></div></div>`;
}
async function addUser(e) {
  e.preventDefault();
  try { await api("/api/users", { method: "POST", body: formData(e.target) }); toast("Đã tạo tài khoản"); users(); }
  catch (x) { toast(x.message, true); }
}
function editUser(id) {
  const u = state.users.find((x) => x.id === id);
  if (!u) return;
  openModal("Sửa tài khoản: " + u.username, `
    <label>Họ tên</label><input name="full_name" value="${esc(u.full_name)}" required>
    <label>Quyền</label><select name="role" ${u.id === state.me.id ? "disabled" : ""}>${state.roleOpts(u.role)}</select>
    <label>Tổ (bắt buộc với Tổ trưởng)</label><select name="team_id">${state.userTeamOpts(u.team_id)}</select>`,
  async (v) => {
    if (u.id === state.me.id) v.role = u.role;
    await api("/api/users/" + id, { method: "PUT", body: v }); toast("Đã cập nhật"); users();
  });
}
function resetPassword(id) {
  const u = state.users.find((x) => x.id === id);
  openModal("Đặt lại mật khẩu: " + u.username, `<label>Mật khẩu mới</label><input name="password" type="password" minlength="6" required autocomplete="new-password">`,
    async (v) => { await api(`/api/users/${id}/password`, { method: "PATCH", body: v }); toast("Đã đặt lại mật khẩu"); });
}
async function toggleUser(id) {
  try { await api(`/api/users/${id}/toggle`, { method: "PATCH" }); users(); }
  catch (x) { toast(x.message, true); }
}
function changePassword() {
  openModal("Đổi mật khẩu", `
    <label>Mật khẩu hiện tại</label><input name="current" type="password" required autocomplete="current-password">
    <label>Mật khẩu mới (≥ 6 ký tự)</label><input name="password" type="password" minlength="6" required autocomplete="new-password">
    <label>Nhập lại mật khẩu mới</label><input name="again" type="password" minlength="6" required autocomplete="new-password">`,
  async (v) => {
    if (v.password !== v.again) throw new Error("Mật khẩu nhập lại không khớp.");
    await api("/api/me/password", { method: "POST", body: { current: v.current, password: v.password } });
    toast("Đã đổi mật khẩu");
  });
}

/* ------------------------------ boot ------------------------------ */
const PAGE_FN = { dashboard, students, scores, records: () => records("all"), teams, conduct, rules, users };

async function boot() {
  try {
    const [me, mo] = await Promise.all([api("/api/me"), api("/api/months")]);
    state.me = me.user; state.months = mo.months;
    $("#meName").textContent = state.me.full_name;
    $("#meRole").textContent = ROLE[state.me.role];
    buildNav(); buildMonthSelect();
    navigate("dashboard");
  } catch (e) {
    $("#content").innerHTML = `<div class="error-box">${esc(e.message)}</div>`;
  }
}
boot();
