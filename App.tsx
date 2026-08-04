import { useEffect, useMemo, useState, useCallback } from "react";
import {
  Wand2, BookOpen, FolderOpen, LayoutDashboard, User as UserIcon,
  LogOut, LogIn, Plus, RefreshCw, Eye, Trash2, Check, X, Loader2
} from "lucide-react";
import type {
  AppView, User, Skill, GenerationJob, Lesson, AdminStats, JobStatus
} from "./types";

const API = "";

async function api<T>(path: string, opts: RequestInit = {}): Promise<T> {
  const token = localStorage.getItem("edulab_token");
  const headers: Record<string, string> = { "Content-Type": "application/json", ...(opts.headers as Record<string, string>) };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(API + path, { ...opts, headers });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data as T;
}

const STATUS_LABEL: Record<JobStatus, string> = {
  queued: "排队中", running: "生成中", succeeded: "已完成", failed: "失败", cancelled: "已取消"
};

function Badge({ status }: { status: string }) {
  return <span className={`badge badge-${status}`}>{STATUS_LABEL[status as JobStatus] || status}</span>;
}

function timeAgo(iso: string) {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "刚刚";
  if (mins < 60) return `${mins} 分钟前`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs} 小时前`;
  return `${Math.floor(hrs / 24)} 天前`;
}

function skillName(skills: Skill[], id: string) {
  return skills.find(s => s.id === id)?.name || id;
}
function problemName(skills: Skill[], skillId: string, key: string) {
  return skills.find(s => s.id === skillId)?.problemTypes.find(p => p.key === key)?.name || key;
}

export default function App() {
  const [view, setView] = useState<AppView>("home");
  const [user, setUser] = useState<User | null>(null);
  const [skills, setSkills] = useState<Skill[]>([]);
  const [jobs, setJobs] = useState<GenerationJob[]>([]);
  const [lessons, setLessons] = useState<Lesson[]>([]);
  const [myLessons, setMyLessons] = useState<Lesson[]>([]);
  const [message, setMessage] = useState("");
  const [viewLessonId, setViewLessonId] = useState("");
  const [authMode, setAuthMode] = useState<"login" | "register">("login");

  useEffect(() => {
    const token = localStorage.getItem("edulab_token");
    if (token) {
      api<{ user: User }>("/api/auth/me").then(d => setUser(d.user)).catch(() => localStorage.removeItem("edulab_token"));
    }
    api<{ skills: Skill[]; installed: boolean }>("/api/catalog/skills").then(d => setSkills(d.skills)).catch(() => {});
  }, []);

  const refreshJobs = useCallback(() => {
    if (!user) return;
    api<{ jobs: GenerationJob[] }>("/api/jobs").then(d => setJobs(d.jobs)).catch(() => {});
  }, [user]);

  const refreshLessons = useCallback(() => {
    api<{ lessons: Lesson[] }>("/api/lessons?visibility=public").then(d => setLessons(d.lessons)).catch(() => {});
    if (user) api<{ lessons: Lesson[] }>("/api/me/lessons").then(d => setMyLessons(d.lessons)).catch(() => {});
  }, [user]);

  useEffect(() => { refreshJobs(); refreshLessons(); }, [refreshJobs, refreshLessons]);
  useEffect(() => {
    if (!user || view !== "jobs") return;
    const hasActive = jobs.some(j => j.status === "queued" || j.status === "running");
    if (!hasActive) return;
    const t = setInterval(refreshJobs, 2000);
    return () => clearInterval(t);
  }, [user, view, jobs, refreshJobs]);

  const nav = useMemo(() => {
    const items: { id: AppView; label: string; icon: typeof BookOpen; auth?: boolean }[] = [
      { id: "home", label: "首页", icon: BookOpen },
      { id: "create", label: "生成课件", icon: Wand2, auth: true },
      { id: "jobs", label: "任务中心", icon: Loader2, auth: true },
      { id: "lessons", label: "课件广场", icon: BookOpen },
      { id: "my-lessons", label: "我的课件", icon: FolderOpen, auth: true }
    ];
    if (user?.role === "teacher" || user?.role === "admin") items.push({ id: "review", label: "教师审核", icon: Check, auth: true });
    if (user?.role === "admin") items.push({ id: "admin", label: "管理后台", icon: LayoutDashboard, auth: true });
    return items.filter(item => !item.auth || !!user);
  }, [user]);

  async function handleLogin(email: string, password: string, register = false, nickname = "") {
    try {
      const path = register ? "/api/auth/register" : "/api/auth/login";
      const body = register ? { email, password, nickname } : { email, password };
      const d = await api<{ user: User; token: string }>(path, { method: "POST", body: JSON.stringify(body) });
      localStorage.setItem("edulab_token", d.token);
      setUser(d.user);
      setView(d.user.role === "admin" ? "admin" : "home");
      setMessage("");
    } catch (e: any) { setMessage(e.message); }
  }
  function handleLogout() {
    api("/api/auth/logout", { method: "POST" }).finally(() => {
      localStorage.removeItem("edulab_token");
      setUser(null); setView("home");
    });
  }
  function openLesson(id: string) { setViewLessonId(id); setView("lesson-view"); }
  function cancelJob(id: string) { return api(`/api/jobs/${id}/cancel`, { method: "POST" }).then(refreshJobs); }
  function retryJob(id: string) { return api(`/api/jobs/${id}/retry`, { method: "POST" }).then(refreshJobs); }

  return (
    <div>
      <nav className="navbar">
        <div className="container navbar-inner">
          <div className="logo" onClick={() => setView("home")} style={{ cursor: "pointer" }}>
            <Wand2 size={22} /> EduLab
          </div>
          <div className="nav-links">
            {nav.map(item => (
              <button key={item.id} className={`nav-link ${view === item.id ? "active" : ""}`} onClick={() => setView(item.id)}>
                <item.icon size={15} style={{ verticalAlign: "-2px", marginRight: 4 }} />{item.label}
              </button>
            ))}
          </div>
          <div>
            {user ? (
              <span style={{ display: "flex", gap: 8, alignItems: "center" }}>
                <button className="nav-link" onClick={() => setView("profile")}><UserIcon size={15} style={{ verticalAlign: "-2px" }} /> {user.nickname}</button>
                <button className="btn btn-secondary btn-sm" onClick={handleLogout}><LogOut size={14} /> 退出</button>
              </span>
            ) : (
              <button className="btn btn-primary btn-sm" onClick={() => { setAuthMode("login"); setView("login"); }}><LogIn size={14} /> 登录</button>
            )}
          </div>
        </div>
      </nav>
      <main className="main">
        <div className="container">

          {view === "home" && <HomeView skills={skills} lessons={lessons} onCreate={() => setView(user ? "create" : "login")} onView={openLesson} />}
          {view === "login" && <LoginView mode={authMode} onLogin={handleLogin} onSwitch={m => setAuthMode(m)} message={message} />}
          {view === "create" && user && <CreateView skills={skills} onCreated={() => { refreshJobs(); setView("jobs"); }} />}
          {view === "jobs" && user && <JobsView jobs={jobs} skills={skills} onView={openLesson} onRefresh={refreshJobs} onCancel={cancelJob} onRetry={retryJob} />}
          {view === "lessons" && <LessonsView lessons={lessons} skills={skills} onView={openLesson} title="课件广场" />}
          {view === "my-lessons" && user && <LessonsView lessons={myLessons} skills={skills} onView={openLesson} title="我的课件" showOwner onDelete={async id => { await api(`/api/lessons/${id}`, { method: "DELETE" }); refreshLessons(); }} onSubmit={async id => { await api(`/api/lessons/${id}/submit`, { method: "POST" }); refreshLessons(); }} />}
          {view === "review" && user && <TeacherReviewView skills={skills} onView={openLesson} />}
          {view === "lesson-view" && <LessonView lessonId={viewLessonId} onBack={() => setView("lessons")} />}
          {view === "profile" && user && <ProfileView user={user} onUpdated={setUser} />}
          {view === "admin" && user?.role === "admin" && <AdminView skills={skills} onView={openLesson} />}
        </div>
      </main>
    </div>
  );
}

function HomeView({ skills, lessons, onCreate, onView }: { skills: Skill[]; lessons: Lesson[]; onCreate: () => void; onView: (id: string) => void }) {
  return (
    <div>
      <div className="hero">
        <h1>EduLab 交互教学课件平台</h1>
        <p>立体几何、解析几何、化学反应 —— 一键生成可交互的教学网页，3D 模型 / 动态画板 / 微观动画，让课堂更直观。</p>
        <div className="hero-actions">
          <button className="btn btn-primary" onClick={onCreate}><Plus size={16} /> 生成课件</button>
          <button className="btn btn-secondary" onClick={() => document.getElementById("lessons-section")?.scrollIntoView({ behavior: "smooth" })}>浏览课件</button>
        </div>
      </div>
      <h2 style={{ fontSize: 20, fontWeight: 700, marginBottom: 16 }}>支持的学科</h2>
      <div className="grid grid-3 mb-24">
        {skills.map(s => (
          <div key={s.id} className="card skill-card" onClick={onCreate}>
            <div className="skill-icon">{s.id === "edu-solid-geometry" ? "🧊" : s.id === "edu-analytic-geometry" ? "📐" : "⚗️"}</div>
            <div className="skill-name">{s.name}</div>
            <div className="skill-desc">{s.description}</div>
            <div style={{ marginTop: 8, fontSize: 12, color: "var(--text-muted)" }}>{s.problemTypes.length} 种题型</div>
          </div>
        ))}
      </div>
      <h2 id="lessons-section" style={{ fontSize: 20, fontWeight: 700, marginBottom: 16 }}>最新公开课件</h2>
      {lessons.length === 0 ? <div className="empty-state">暂无公开课件</div> : (
        <div className="grid grid-3">
          {lessons.slice(0, 6).map(l => (
            <div key={l.id} className="card lesson-card" onClick={() => onView(l.id)} style={{ cursor: "pointer" }}>
              <div className="lesson-title">{l.title}</div>
              <div className="lesson-meta">{skillName(skills, l.skillId)} · {timeAgo(l.createdAt)}</div>
              <div className="lesson-actions"><button className="btn btn-sm btn-secondary"><Eye size={13} /> 预览</button></div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function LoginView({ mode, onLogin, onSwitch, message }: { mode: "login" | "register"; onLogin: (email: string, password: string, register?: boolean, nickname?: string) => void; onSwitch: (m: "login" | "register") => void; message: string }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [nickname, setNickname] = useState("");
  return (
    <div className="auth-box">
      <div className="card">
        <div className="auth-tabs">
          <button className={`auth-tab ${mode === "login" ? "active" : ""}`} onClick={() => onSwitch("login")}>登录</button>
          <button className={`auth-tab ${mode === "register" ? "active" : ""}`} onClick={() => onSwitch("register")}>注册</button>
        </div>
        {message && <div className="alert alert-error">{message}</div>}
        <form onSubmit={e => { e.preventDefault(); onLogin(email, password, mode === "register", nickname); }}>
          {mode === "register" && (
            <div className="form-group"><label className="form-label">昵称</label><input className="input" value={nickname} onChange={e => setNickname(e.target.value)} required /></div>
          )}
          <div className="form-group"><label className="form-label">邮箱</label><input className="input" type="email" value={email} onChange={e => setEmail(e.target.value)} required /></div>
          <div className="form-group"><label className="form-label">密码</label><input className="input" type="password" value={password} onChange={e => setPassword(e.target.value)} required minLength={6} /></div>
          <button className="btn btn-primary" style={{ width: "100%" }} type="submit">{mode === "login" ? "登录" : "注册"}</button>
        </form>
      </div>
    </div>
  );
}

function CreateView({ skills, onCreated }: { skills: Skill[]; onCreated: () => void }) {
  const [skillId, setSkillId] = useState(skills[0]?.id || "");
  const [problemType, setProblemType] = useState("");
  const [seed, setSeed] = useState(0);
  const [title, setTitle] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");

  const skill = skills.find(s => s.id === skillId);
  const pt = skill?.problemTypes.find(p => p.key === problemType);

  useEffect(() => {
    if (skill && !skill.problemTypes.find(p => p.key === problemType)) {
      setProblemType(skill.problemTypes[0]?.key || "");
    }
  }, [skillId]);

  async function submit() {
    if (!skillId || !problemType) { setError("请选择学科和题型"); return; }
    setSubmitting(true); setError("");
    try {
      const params: Record<string, unknown> = {};
      if (problemType === "random") params.seed = seed;
      await api("/api/jobs", { method: "POST", body: JSON.stringify({ skillId, problemType, params, title }) });
      onCreated();
    } catch (e: any) { setError(e.message); setSubmitting(false); }
  }

  return (
    <div style={{ maxWidth: 640, margin: "0 auto" }}>
      <h1 className="page-title">生成交互课件</h1>
      <p className="page-subtitle">选择学科和题型，一键生成自包含的交互教学网页。</p>
      {error && <div className="alert alert-error">{error}</div>}
      <div className="card">
        <div className="form-group">
          <label className="form-label">学科</label>
          <div className="grid grid-3" style={{ gap: 12 }}>
            {skills.map(s => (
              <div key={s.id} className={`card skill-card ${skillId === s.id ? "selected" : ""}`} onClick={() => setSkillId(s.id)} style={{ padding: 16, margin: 0 }}>
                <div style={{ fontSize: 24 }}>{s.id === "edu-solid-geometry" ? "🧊" : s.id === "edu-analytic-geometry" ? "📐" : "⚗️"}</div>
                <div style={{ fontWeight: 600, fontSize: 14 }}>{s.name}</div>
              </div>
            ))}
          </div>
        </div>
        <div className="form-group">
          <label className="form-label">题型</label>
          <select className="form-select" value={problemType} onChange={e => setProblemType(e.target.value)}>
            {skill?.problemTypes.map(p => <option key={p.key} value={p.key}>{p.name}</option>)}
          </select>
        </div>
        {problemType === "random" && (
          <div className="form-group">
            <label className="form-label">随机种子</label>
            <input className="input" type="number" value={seed} onChange={e => setSeed(Number(e.target.value))} />
          </div>
        )}
        <div className="form-group">
          <label className="form-label">课件标题（可选）</label>
          <input className="input" value={title} onChange={e => setTitle(e.target.value)} placeholder="留空则自动生成" />
        </div>
        <button className="btn btn-primary" onClick={submit} disabled={submitting} style={{ width: "100%" }}>
          {submitting ? <><Loader2 size={16} className="spin" /> 提交中...</> : <><Wand2 size={16} /> 开始生成</>}
        </button>
      </div>
    </div>
  );
}

function JobsView({ jobs, skills, onView, onRefresh, onCancel, onRetry }: { jobs: GenerationJob[]; skills: Skill[]; onView: (id: string) => void; onRefresh: () => void; onCancel: (id: string) => Promise<unknown>; onRetry: (id: string) => Promise<unknown> }) {
  const [filter, setFilter] = useState<string>("all");
  const filtered = filter === "all" ? jobs : jobs.filter(j => j.status === filter);
  return (
    <div>
      <div className="flex items-center justify-between mb-16">
        <div>
          <h1 className="page-title">任务中心</h1>
          <p className="page-subtitle" style={{ marginBottom: 0 }}>查看课件生成任务的状态和进度。</p>
        </div>
        <button className="btn btn-secondary btn-sm" onClick={onRefresh}><RefreshCw size={14} /> 刷新</button>
      </div>
      <div className="flex gap-8 mb-16">
        {["all", "queued", "running", "succeeded", "failed", "cancelled"].map(f => (
          <button key={f} className={`btn btn-sm ${filter === f ? "btn-primary" : "btn-secondary"}`} onClick={() => setFilter(f)}>
            {f === "all" ? "全部" : STATUS_LABEL[f as JobStatus]}
          </button>
        ))}
      </div>
      {filtered.length === 0 ? <div className="empty-state card">暂无任务</div> : (
        <div className="grid">
          {filtered.map(j => (
            <div key={j.id} className="card">
              <div className="flex items-center justify-between mb-16">
                <div>
                  <div style={{ fontWeight: 600 }}>{j.title || problemName(skills, j.skillId, j.problemType)}</div>
                  <div style={{ fontSize: 13, color: "var(--text-muted)" }}>{skillName(skills, j.skillId)} · {problemName(skills, j.skillId, j.problemType)} · {timeAgo(j.createdAt)}</div>
                </div>
                <Badge status={j.status} />
              </div>
              {(j.status === "queued" || j.status === "running") && (
                <div className="progress-bar mb-16"><div className="progress-fill" style={{ width: `${j.progress}%` }} /></div>
              )}
              <div style={{ fontSize: 13, color: "var(--text-muted)" }}>{j.currentStage}{j.errorMessage ? ` — ${j.errorMessage}` : ""}</div>
              {(j.status === "queued" || j.status === "running") && <button className="btn btn-sm btn-danger" style={{ marginTop: 8 }} onClick={() => onCancel(j.id)}>取消</button>}
              {(j.status === "failed" || j.status === "cancelled") && <button className="btn btn-sm btn-secondary" style={{ marginTop: 8 }} onClick={() => onRetry(j.id)}>重试</button>}
              {j.status === "succeeded" && j.resultLessonId && (
                <div style={{ marginTop: 8 }}><button className="btn btn-sm btn-secondary" onClick={() => onView(j.resultLessonId!)}><Eye size={13} /> 查看课件</button></div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function LessonsView({ lessons, skills, onView, title, showOwner, onDelete, onSubmit }: { lessons: Lesson[]; skills: Skill[]; onView: (id: string) => void; title: string; showOwner?: boolean; onDelete?: (id: string) => Promise<void>; onSubmit?: (id: string) => Promise<void> }) {
  return (
    <div>
      <h1 className="page-title">{title}</h1>
      <p className="page-subtitle">浏览和管理交互教学课件。</p>
      {lessons.length === 0 ? <div className="empty-state card">暂无课件</div> : (
        <div className="grid grid-3">
          {lessons.map(l => (
            <div key={l.id} className="card lesson-card" onClick={() => onView(l.id)} style={{ cursor: "pointer" }}>
              <div className="lesson-title">{l.title}</div>
              <div className="lesson-meta">{skillName(skills, l.skillId)} · {problemName(skills, l.skillId, l.problemType)}</div>
              <div className="lesson-meta">{timeAgo(l.createdAt)} · {l.viewCount} 次浏览</div>
              <div className="flex gap-8" style={{ flexWrap: "wrap" }}>
                <span className={`badge badge-${l.visibility}`}>{l.visibility === "public" ? "公开" : "私有"}</span>
                <span className={`badge badge-${l.publishStatus}`}>{{ draft: "草稿", pending: "待审核", approved: "已通过", rejected: "已拒绝" }[l.publishStatus] || l.publishStatus}</span>
              </div>
              <div className="lesson-actions">
                <button className="btn btn-sm btn-secondary" onClick={e => { e.stopPropagation(); onView(l.id); }}><Eye size={13} /> 预览</button>
                {showOwner && onSubmit && l.publishStatus !== "approved" && <button className="btn btn-sm btn-primary" onClick={e => { e.stopPropagation(); onSubmit(l.id); }}>提交审核</button>}
                {showOwner && onDelete && <button className="btn btn-sm btn-danger" onClick={e => { e.stopPropagation(); onDelete(l.id); }}><Trash2 size={13} /></button>}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function LessonView({ lessonId, onBack }: { lessonId: string; onBack: () => void }) {
  const [lesson, setLesson] = useState<Lesson | null>(null);
  const [previewUrl, setPreviewUrl] = useState("");
  useEffect(() => {
    if (lessonId) api<{ lesson: Lesson }>(`/api/lessons/${lessonId}`).then(async d => {
      setLesson(d.lesson);
      try { setPreviewUrl((await api<{ url: string }>(`/api/lessons/${lessonId}/preview-url`, { method: "POST" })).url); }
      catch { setPreviewUrl(`/lessons/${encodeURIComponent(lessonId)}/view`); }
    }).catch(() => setLesson(null));
  }, [lessonId]);
  if (!lesson) return <div className="empty-state">加载中...</div>;
  const viewSrc = previewUrl || `/lessons/${encodeURIComponent(lesson.id)}/view`;
  return (
    <div>
      <div className="flex items-center justify-between mb-16">
        <div>
          <h1 className="page-title" style={{ fontSize: 20 }}>{lesson.title}</h1>
          <div style={{ fontSize: 13, color: "var(--text-muted)" }}>{lesson.viewCount} 次浏览 · {timeAgo(lesson.createdAt)}</div>
        </div>
        <button className="btn btn-secondary btn-sm" onClick={onBack}>返回</button>
      </div>
      <iframe className="lesson-frame" src={viewSrc} title={lesson.title} />
    </div>
  );
}

function TeacherReviewView({ skills, onView }: { skills: Skill[]; onView: (id: string) => void }) {
  const [lessons, setLessons] = useState<Lesson[]>([]);
  const load = () => api<{ lessons: Lesson[] }>("/api/teacher/lessons").then(d => setLessons(d.lessons)).catch(() => setLessons([]));
  useEffect(() => { load(); }, []);
  async function review(id: string, action: "approve" | "reject") {
    await api(`/api/teacher/lessons/${id}/review`, { method: "POST", body: JSON.stringify({ action }) });
    load();
  }
  return <div><h1 className="page-title">教师审核</h1><p className="page-subtitle">处理待审核的公开课件。</p>{lessons.length === 0 ? <div className="empty-state card">暂无待审核课件</div> : <div className="grid">{lessons.map(l => <div key={l.id} className="card flex items-center justify-between"><div><div style={{ fontWeight: 600 }}>{l.title}</div><div className="lesson-meta">{skillName(skills, l.skillId)} · {timeAgo(l.createdAt)}</div></div><div className="flex gap-8"><button className="btn btn-sm btn-secondary" onClick={() => onView(l.id)}><Eye size={13} /></button><button className="btn btn-sm" style={{ background: "var(--success)", color: "#fff" }} onClick={() => review(l.id, "approve")}><Check size={13} /></button><button className="btn btn-sm btn-danger" onClick={() => review(l.id, "reject")}><X size={13} /></button></div></div>)}</div>}</div>;
}

function ProfileView({ user, onUpdated }: { user: User; onUpdated: (u: User) => void }) {
  const [nickname, setNickname] = useState(user.nickname);
  const [password, setPassword] = useState("");
  const [msg, setMsg] = useState("");
  async function save() {
    try {
      const body: Record<string, string> = { nickname };
      if (password) body.password = password;
      const d = await api<{ user: User }>("/api/me/profile", { method: "PATCH", body: JSON.stringify(body) });
      onUpdated(d.user); setMsg("已保存"); setPassword("");
    } catch (e: any) { setMsg(e.message); }
  }
  return (
    <div style={{ maxWidth: 480, margin: "0 auto" }}>
      <h1 className="page-title">个人资料</h1>
      <div className="card">
        <div className="form-group"><label className="form-label">邮箱</label><input className="input" value={user.email} disabled /></div>
        <div className="form-group"><label className="form-label">昵称</label><input className="input" value={nickname} onChange={e => setNickname(e.target.value)} /></div>
        <div className="form-group"><label className="form-label">新密码（留空不修改）</label><input className="input" type="password" value={password} onChange={e => setPassword(e.target.value)} minLength={6} /></div>
        {msg && <div className="alert alert-success">{msg}</div>}
        <button className="btn btn-primary" onClick={save}>保存</button>
      </div>
    </div>
  );
}

function AdminView({ skills, onView }: { skills: Skill[]; onView: (id: string) => void }) {
  const [stats, setStats] = useState<AdminStats | null>(null);
  const [users, setUsers] = useState<User[]>([]);
  const [allLessons, setAllLessons] = useState<Lesson[]>([]);
  const [config, setConfig] = useState<Record<string, string>>({});
  const [catalog, setCatalog] = useState<{ skill_id: string; problem_type: string; enabled: number }[]>([]);
  const [tab, setTab] = useState<"stats" | "users" | "lessons" | "config">("stats");

  function load() {
    api<AdminStats>("/api/admin/stats").then(setStats).catch(() => {});
    api<{ users: User[] }>("/api/admin/users").then(d => setUsers(d.users)).catch(() => {});
    api<{ lessons: Lesson[] }>("/api/admin/lessons").then(d => setAllLessons(d.lessons)).catch(() => {});
    api<{ config: Record<string, string> }>("/api/admin/config").then(d => setConfig(d.config)).catch(() => {});
    api<{ catalog: { skill_id: string; problem_type: string; enabled: number }[] }>("/api/admin/catalog").then(d => setCatalog(d.catalog)).catch(() => {});
  }
  useEffect(() => { load(); }, []);

  async function setUserRole(id: string, role: string) {
    await api(`/api/admin/users/${id}`, { method: "PATCH", body: JSON.stringify({ role }) });
    load();
  }
  async function setUserStatus(id: string, status: string) {
    await api(`/api/admin/users/${id}`, { method: "PATCH", body: JSON.stringify({ status }) });
    load();
  }
  async function reviewLesson(id: string, action: "approve" | "reject") {
    await api(`/api/admin/lessons/${id}/review`, { method: "POST", body: JSON.stringify({ action }) });
    load();
  }

  return (
    <div>
      <h1 className="page-title">管理后台</h1>
      <p className="page-subtitle">平台数据概览、用户管理和课件审核。</p>
      <div className="flex gap-8 mb-24">
        {(["stats", "users", "lessons", "config"] as const).map(t => (
          <button key={t} className={`btn btn-sm ${tab === t ? "btn-primary" : "btn-secondary"}`} onClick={() => setTab(t)}>
            {t === "stats" ? "数据概览" : t === "users" ? "用户管理" : t === "lessons" ? "课件管理" : "系统配置"}
          </button>
        ))}
      </div>
      {tab === "stats" && stats && (
        <div className="grid grid-3">
          <div className="card stat-card"><div className="stat-value">{stats.users}</div><div className="stat-label">用户数</div></div>
          <div className="card stat-card"><div className="stat-value">{stats.jobs}</div><div className="stat-label">任务总数</div></div>
          <div className="card stat-card"><div className="stat-value">{stats.runningJobs}</div><div className="stat-label">运行中</div></div>
          <div className="card stat-card"><div className="stat-value">{stats.lessons}</div><div className="stat-label">课件数</div></div>
          <div className="card stat-card"><div className="stat-value">{stats.pendingReviews}</div><div className="stat-label">待审核</div></div>
        </div>
      )}
      {tab === "users" && (
        <div className="card" style={{ padding: 0 }}>
          <table className="table">
            <thead><tr><th>邮箱</th><th>昵称</th><th>角色</th><th>状态</th><th>操作</th></tr></thead>
            <tbody>
              {users.map(u => (
                <tr key={u.id}>
                  <td>{u.email}</td><td>{u.nickname}</td>
                  <td><select className="form-select" style={{ width: 100, padding: "4px 8px" }} value={u.role} onChange={e => setUserRole(u.id, e.target.value)}>
                    <option value="student">学生</option><option value="teacher">教师</option><option value="admin">管理员</option>
                  </select></td>
                  <td><span className={`badge badge-${u.status === "active" ? "succeeded" : "failed"}`}>{u.status === "active" ? "正常" : "禁用"}</span></td>
                  <td><button className="btn btn-sm btn-secondary" onClick={() => setUserStatus(u.id, u.status === "active" ? "disabled" : "active")}>
                    {u.status === "active" ? "禁用" : "启用"}
                  </button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {tab === "lessons" && (
        <div className="grid">
          {allLessons.map(l => (
            <div key={l.id} className="card flex items-center justify-between">
              <div>
                <div style={{ fontWeight: 600 }}>{l.title}</div>
                <div style={{ fontSize: 13, color: "var(--text-muted)" }}>{skillName(skills, l.skillId)} · {problemName(skills, l.skillId, l.problemType)} · {timeAgo(l.createdAt)}</div>
                <div style={{ marginTop: 4 }}><span className={`badge badge-${l.publishStatus}`}>{{ draft: "草稿", pending: "待审核", approved: "已通过", rejected: "已拒绝" }[l.publishStatus]}</span></div>
              </div>
              <div className="flex gap-8">
                <button className="btn btn-sm btn-secondary" onClick={() => onView(l.id)}><Eye size={13} /> 预览</button>
                <button className="btn btn-sm" style={{ background: "var(--success)", color: "#fff" }} onClick={() => reviewLesson(l.id, "approve")}><Check size={13} /></button>
                <button className="btn btn-sm btn-danger" onClick={() => reviewLesson(l.id, "reject")}><X size={13} /></button>
              </div>
            </div>
          ))}
        </div>
      )}
      {tab === "config" && (
        <div className="grid">
          <div className="card"><h3>Worker 配置</h3><div className="form-group"><label className="form-label">并发数</label><input className="input" value={config.worker_concurrency || "1"} onChange={e => setConfig({ ...config, worker_concurrency: e.target.value })} /></div><div className="form-group"><label className="form-label">Python 可执行文件</label><input className="input" value={config.python_bin || "python3"} onChange={e => setConfig({ ...config, python_bin: e.target.value })} /></div><button className="btn btn-primary" onClick={async () => { await api("/api/admin/config", { method: "PATCH", body: JSON.stringify({ worker_concurrency: config.worker_concurrency, python_bin: config.python_bin, lesson_artifacts_root: config.lesson_artifacts_root }) }); load(); }}>保存配置</button></div>
          <div className="card"><h3>题型启用</h3>{catalog.map(item => <label key={`${item.skill_id}:${item.problem_type}`} style={{ display: "block", margin: "8px 0" }}><input type="checkbox" checked={Number(item.enabled) !== 0} onChange={async e => { await api(`/api/admin/catalog/${item.skill_id}/${item.problem_type}`, { method: "PATCH", body: JSON.stringify({ enabled: e.target.checked }) }); load(); }} /> {item.skill_id} / {item.problem_type}</label>)}</div>
        </div>
      )}
    </div>
  );
}
