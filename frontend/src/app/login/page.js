"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";

const API_BASE = process.env.NEXT_PUBLIC_API_BASE ?? "http://localhost:5000";

export default function LoginPage() {
  const router = useRouter();
  const [tab, setTab]           = useState("login");   // "login" | "register"
  const [email, setEmail]       = useState("");
  const [password, setPassword] = useState("");
  const [name, setName]         = useState("");
  const [loading, setLoading]   = useState(false);
  const [error, setError]       = useState("");
  const [showPass, setShowPass] = useState(false);
  const [mounted, setMounted]   = useState(false);

  useEffect(() => {
    const token = localStorage.getItem("irriga_token");
    
    // FIX: If they already have a token, send them to the dashboard.
    if (token) {
      window.location.href = "/";
      return;
    }

    // Otherwise, it's safe to render the login form.
    setMounted(true);
  }, []);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError("");
    setLoading(true);

    const endpoint = tab === "login"
      ? `${API_BASE}/api/v1/auth/login`
      : `${API_BASE}/api/v1/auth/register`;

    const body = tab === "login"
      ? { email, password }
      : { email, password, name };

    try {
      const res  = await fetch(endpoint, {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify(body),
      });
      const data = await res.json();

      if (!res.ok) {
        setError(data.error ?? "Something went wrong.");
        return;
      }

      // Store token + basic user info
      localStorage.setItem("irriga_token", data.token);
      localStorage.setItem("irriga_user",  JSON.stringify(data.user));
      router.replace("/");
    } catch {
      setError("Could not reach the server. Check your connection.");
    } finally {
      setLoading(false);
    }
  };

  if (!mounted) return null;

  return (
    <div style={s.root}>
      {/* Grain overlay */}
      <div style={s.grain} />

      <div style={s.wrapper}>
        {/* Brand mark */}
        <div style={s.brand}>
          <svg width="36" height="36" viewBox="0 0 36 36" fill="none">
            <circle cx="18" cy="18" r="16" fill="#2d7a4f18" stroke="#2d7a4f" strokeWidth="1.5"/>
            <path d="M18 8v10l6 4" stroke="#2d7a4f" strokeWidth="1.5" strokeLinecap="round"/>
            <circle cx="18" cy="18" r="2.5" fill="#2d7a4f"/>
          </svg>
          <div>
            <div style={s.brandName}>
              IRRIGA<span style={s.accent}>NET</span>
            </div>
            <div style={s.brandSub}>Field Management Console</div>
          </div>
        </div>

        {/* Card */}
        <div style={s.card}>
          {/* Tab switcher */}
          <div style={s.tabs}>
            <button
              onClick={() => { setTab("login"); setError(""); }}
              style={{ ...s.tab, ...(tab === "login" ? s.tabActive : {}) }}
            >
              Sign In
            </button>
            <button
              onClick={() => { setTab("register"); setError(""); }}
              style={{ ...s.tab, ...(tab === "register" ? s.tabActive : {}) }}
            >
              Register
            </button>
          </div>

          <div style={s.cardBody}>
            <h2 style={s.heading}>
              {tab === "login" ? "Welcome back." : "Create an account."}
            </h2>
            <p style={s.subheading}>
              {tab === "login"
                ? "Sign in to monitor your irrigation network."
                : "First account registered becomes the admin."}
            </p>

            {/* Error banner */}
            {error && (
              <div style={s.errorBanner}>
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none"
                  stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
                  <circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/>
                  <line x1="12" y1="16" x2="12.01" y2="16"/>
                </svg>
                {error}
              </div>
            )}

            <form onSubmit={handleSubmit} style={s.form}>
              {/* Name field — register only */}
              {tab === "register" && (
                <div style={s.field}>
                  <label style={s.label} htmlFor="name">Full Name</label>
                  <input
                    id="name"
                    type="text"
                    autoComplete="name"
                    required
                    value={name}
                    onChange={e => setName(e.target.value)}
                    placeholder="Ada Lovelace"
                    style={s.input}
                    onFocus={e => Object.assign(e.target.style, s.inputFocus)}
                    onBlur={e  => Object.assign(e.target.style, s.inputBlur)}
                  />
                </div>
              )}

              {/* Email */}
              <div style={s.field}>
                <label style={s.label} htmlFor="email">Email Address</label>
                <input
                  id="email"
                  type="email"
                  autoComplete="email"
                  required
                  value={email}
                  onChange={e => setEmail(e.target.value)}
                  placeholder="you@example.com"
                  style={s.input}
                  onFocus={e => Object.assign(e.target.style, s.inputFocus)}
                  onBlur={e  => Object.assign(e.target.style, s.inputBlur)}
                />
              </div>

              {/* Password */}
              <div style={s.field}>
                <label style={s.label} htmlFor="password">Password</label>
                <div style={s.passWrap}>
                  <input
                    id="password"
                    type={showPass ? "text" : "password"}
                    autoComplete={tab === "login" ? "current-password" : "new-password"}
                    required
                    minLength={8}
                    value={password}
                    onChange={e => setPassword(e.target.value)}
                    placeholder="Min. 8 characters"
                    style={{ ...s.input, paddingRight: "44px", marginBottom: 0 }}
                    onFocus={e => Object.assign(e.target.style, s.inputFocus)}
                    onBlur={e  => Object.assign(e.target.style, s.inputBlur)}
                  />
                  <button
                    type="button"
                    onClick={() => setShowPass(v => !v)}
                    style={s.eyeBtn}
                    tabIndex={-1}
                    aria-label={showPass ? "Hide password" : "Show password"}
                  >
                    {showPass
                      ? <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M17.94 17.94A10.07 10.07 0 0112 20c-7 0-11-8-11-8a18.45 18.45 0 015.06-5.94M9.9 4.24A9.12 9.12 0 0112 4c7 0 11 8 11 8a18.5 18.5 0 01-2.16 3.19"/><line x1="1" y1="1" x2="23" y2="23"/></svg>
                      : <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
                    }
                  </button>
                </div>
              </div>

              {/* Submit */}
              <button
                type="submit"
                disabled={loading}
                style={{ ...s.submitBtn, opacity: loading ? 0.7 : 1 }}
              >
                {loading
                  ? (tab === "login" ? "Signing in..." : "Registering...")
                  : (tab === "login" ? "Sign In"     : "Create Account")
                }
              </button>
            </form>
          </div>
        </div>
      </div>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Space+Mono:wght@400;700&family=Literata:wght@400;600&display=swap');
        * { box-sizing: border-box; margin: 0; padding: 0; }
        body { background: #f5f2eb; }
      `}</style>
    </div>
  );
}

const s = {
  root: {
    minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center",
    background: "#f5f2eb", fontFamily: "'Literata', Georgia, serif", color: "#2a2820",
    position: "relative", overflow: "hidden", padding: "20px"
  },
  grain: {
    position: "fixed", inset: 0, pointerEvents: "none", zIndex: 0,
    backgroundImage: `url("data:image/svg+xml,%3Csvg viewBox='0 0 256 256' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='4' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)' opacity='0.04'/%3E%3C/svg%3E")`,
  },
  wrapper: {
    position: "relative", zIndex: 1, width: "100%", maxWidth: "420px",
    display: "flex", flexDirection: "column", gap: "32px"
  },
  brand: { display: "flex", alignItems: "center", justifyContent: "center", gap: "12px" },
  brandName: { fontFamily: "'Space Mono', monospace", fontSize: "28px", fontWeight: 700, letterSpacing: "0.12em", lineHeight: 1 },
  accent: { color: "#2d7a4f" },
  brandSub: { fontFamily: "'Space Mono', monospace", fontSize: "11px", letterSpacing: "0.14em", textTransform: "uppercase", color: "#7a7568", marginTop: "4px" },
  card: { background: "#edeae0", border: "1px solid #d4cfc4", borderRadius: "8px", overflow: "hidden", boxShadow: "0 10px 30px rgba(0,0,0,0.05)" },
  tabs: { display: "flex", borderBottom: "1px solid #d4cfc4" },
  tab: { flex: 1, padding: "14px", background: "#e8e3d8", border: "none", fontFamily: "'Space Mono', monospace", fontSize: "12px", textTransform: "uppercase", letterSpacing: "0.1em", color: "#7a7568", cursor: "pointer", transition: "all 0.2s" },
  tabActive: { background: "#edeae0", color: "#2d7a4f", fontWeight: 700, borderBottom: "2px solid #2d7a4f" },
  cardBody: { padding: "32px 28px" },
  heading: { fontSize: "22px", fontWeight: 600, marginBottom: "6px" },
  subheading: { fontFamily: "'Space Mono', monospace", fontSize: "12px", color: "#7a7568", marginBottom: "24px" },
  errorBanner: { display: "flex", alignItems: "center", gap: "8px", padding: "12px 16px", background: "#fdf0ee", color: "#c0392b", border: "1px solid #f0c4bc", borderRadius: "4px", marginBottom: "20px", fontFamily: "'Space Mono', monospace", fontSize: "11px" },
  form: { display: "flex", flexDirection: "column", gap: "16px" },
  field: { display: "flex", flexDirection: "column", gap: "6px" },
  label: { fontFamily: "'Space Mono', monospace", fontSize: "11px", textTransform: "uppercase", letterSpacing: "0.05em", color: "#4a4640" },
  input: { width: "100%", padding: "12px 14px", background: "#f5f2eb", border: "1px solid #d4cfc4", borderRadius: "4px", fontFamily: "'Space Mono', monospace", fontSize: "13px", color: "#2a2820", outline: "none", transition: "border-color 0.2s" },
  inputFocus: { borderColor: "#2d7a4f" },
  inputBlur: { borderColor: "#d4cfc4" },
  passWrap: { position: "relative", display: "flex", alignItems: "center" },
  eyeBtn: { position: "absolute", right: "12px", background: "none", border: "none", color: "#7a7568", cursor: "pointer", display: "flex" },
  submitBtn: { marginTop: "12px", width: "100%", padding: "14px", background: "#2d7a4f", color: "#fff", border: "none", borderRadius: "4px", fontFamily: "'Space Mono', monospace", fontSize: "13px", textTransform: "uppercase", letterSpacing: "0.1em", fontWeight: 700, cursor: "pointer", transition: "background 0.2s" }
};