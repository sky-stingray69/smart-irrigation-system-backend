"use client";

import { useState, useEffect, useCallback } from "react";
import { useRouter } from "next/navigation";

const API_BASE = process.env.NEXT_PUBLIC_API_BASE ?? "http://localhost:5000";

// ─── Auth helpers ─────────────────────────────────────────────────────────────
function getToken()    { return typeof window !== "undefined" ? localStorage.getItem("irriga_token") : null; }
function getUser()     { try { return JSON.parse(localStorage.getItem("irriga_user") ?? "null"); } catch { return null; } }
function clearSession(){ localStorage.removeItem("irriga_token"); localStorage.removeItem("irriga_user"); }

// ─── API Hook ─────────────────────────────────────────────────────────────────
// Replace the fetch() inside fetchData with your own API call.
// Expected shape: array of node objects:
// [
//   {
//     node_id:                    "node_abc123",
//     location_name:              "Field A - North",
//     crop_type:                  "Wheat",
//     is_active:                  true,
//     moisture_threshold_percent: 40,
//     latest: {
//       soil_moisture_percent:    28.4,
//       humidity_percent:         61.0,
//       temperature_c:            31.2,
//       timestamp:                "2025-01-15T08:30:00Z",
//     }
//   }, ...
// ]
function useNodeData(token) {
  const [data, setData]               = useState([]);
  const [loading, setLoading]         = useState(true);
  const [error, setError]             = useState(null);
  const [lastUpdated, setLastUpdated] = useState(null);

  const fetchData = useCallback(async () => {
    if (!token) return;
    setLoading(true);
    setError(null);
    try {
      // ── YOUR API CALL HERE ──────────────────────────────────────────────
      const res = await fetch(`${API_BASE}/api/v1/portal/nodes`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (res.status === 401) throw new Error("UNAUTHORIZED");
      if (!res.ok)            throw new Error(`HTTP ${res.status}: ${res.statusText}`);
      const json = await res.json();
      setData(json.nodes ?? json);
      // ── END OF YOUR API CALL ────────────────────────────────────────────
      setLastUpdated(new Date());
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => {
    fetchData();
    const id = setInterval(fetchData, 60_000);
    return () => clearInterval(id);
  }, [fetchData]);

  return { data, loading, error, lastUpdated, refetch: fetchData };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function moistureStatus(moisture, threshold) {
  if (moisture == null)           return { label: "No Data", color: "#6b6b5c" };
  if (moisture < threshold * 0.6) return { label: "Critical", color: "#c0392b" };
  if (moisture < threshold)       return { label: "Low",      color: "#e67e22" };
  return                                 { label: "Optimal",  color: "#2d7a4f" };
}
function fmt(val, unit = "", decimals = 1) {
  if (val == null) return "—";
  return `${Number(val).toFixed(decimals)}${unit}`;
}
function timeAgo(iso) {
  if (!iso) return "—";
  const secs = Math.floor((Date.now() - new Date(iso)) / 1000);
  if (secs < 60)    return `${secs}s ago`;
  if (secs < 3600)  return `${Math.floor(secs / 60)}m ago`;
  if (secs < 86400) return `${Math.floor(secs / 3600)}h ago`;
  return new Date(iso).toLocaleDateString();
}
function roleBadgeColor(role) {
  return role === "admin"
    ? { bg: "#2d7a4f18", color: "#2d7a4f", border: "#2d7a4f44" }
    : { bg: "#7a756818", color: "#7a7568", border: "#7a756844" };
}

// ─── Sub-components ───────────────────────────────────────────────────────────
function StatCard({ label, value, unit, sub }) {
  return (
    <div style={styles.statCard}>
      <span style={styles.statLabel}>{label}</span>
      <span style={styles.statValue}>
        {value}
        {unit && <span style={styles.statUnit}>{unit}</span>}
      </span>
      {sub && <span style={styles.statSub}>{sub}</span>}
    </div>
  );
}

function StatusBadge({ moisture, threshold }) {
  const s = moistureStatus(moisture, threshold);
  return (
    <span style={{ ...styles.badge, background: s.color + "22", color: s.color, border: `1px solid ${s.color}55` }}>
      <span style={{ ...styles.badgeDot, background: s.color }} />
      {s.label}
    </span>
  );
}

function MoistureBar({ value, threshold }) {
  if (value == null) return <span style={styles.noData}>—</span>;
  const pct      = Math.min(value, 100);
  const crit     = value < threshold * 0.6;
  const warn     = value < threshold;
  const barColor = crit ? "#c0392b" : warn ? "#e67e22" : "#2d7a4f";
  return (
    <div style={styles.barWrap}>
      <div style={styles.barTrack}>
        <div style={{ ...styles.barFill, width: `${pct}%`, background: barColor }} />
        <div style={{ ...styles.barThreshold, left: `${threshold}%` }} />
      </div>
      <span style={{ ...styles.barLabel, color: barColor }}>{fmt(value, "%")}</span>
    </div>
  );
}

function Skeleton() {
  return (
    <tr>
      {Array.from({ length: 8 }).map((_, i) => (
        <td key={i} style={styles.td}><div style={styles.skeletonCell} /></td>
      ))}
    </tr>
  );
}

// ─── Main Dashboard ───────────────────────────────────────────────────────────
export default function Home() {
  const router = useRouter();
  const [token, setToken] = useState(null);
  const [user, setUser] = useState(null);
  const [ready, setReady] = useState(false);

  // 1. Define missing state for sorting and filtering
  const [sortKey, setSortKey] = useState("location_name");
  const [sortDir, setSortDir] = useState("asc");
  const [filter, setFilter] = useState("all");

  // 2. Call the hook (Must be before the useEffects that use 'error' or 'data')
  const { data, loading, error, lastUpdated, refetch } = useNodeData(token);

  // 3. Auth guard — runs once client-side
  useEffect(() => {
    const t = getToken();
    const u = getUser();

    if (!t) {
      window.location.href = "/login";
      return;
    }

    setToken(t);
    setUser(u);
    setReady(true);
  }, []);

  // 4. Auto-logout effect
  useEffect(() => {
    if (error === "UNAUTHORIZED") {
      console.warn("Session expired. Redirecting...");
      clearSession();
      window.location.href = "/login";
    }
  }, [error]);

  const handleLogout = () => {
    clearSession();
    window.location.href = "/login";
  };

  const toggleSort = (key) => {
    if (sortKey === key) setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    else {
      setSortKey(key);
      setSortDir("asc");
    }
  };

  // Logic for filtering and sorting
  const filtered = (data || []).filter((n) => {
    if (filter === "active") return n.is_active;
    if (filter === "inactive") return !n.is_active;
    if (filter === "alert") return n.latest && n.latest.soil_moisture_percent < n.moisture_threshold_percent;
    return true;
  });

  const sorted = [...filtered].sort((a, b) => {
    let va = a[sortKey] ?? a.latest?.[sortKey] ?? "";
    let vb = b[sortKey] ?? b.latest?.[sortKey] ?? "";
    if (typeof va === "string") va = va.toLowerCase();
    if (typeof vb === "string") vb = vb.toLowerCase();
    return sortDir === "asc" ? (va > vb ? 1 : -1) : (va < vb ? 1 : -1);
  });

  const activeCount = data.filter((n) => n.is_active).length;
  const alertCount = data.filter((n) => n.latest && n.latest.soil_moisture_percent < n.moisture_threshold_percent).length;
  const avgMoisture = data.filter((n) => n.latest?.soil_moisture_percent != null)
    .reduce((s, n, _, a) => s + n.latest.soil_moisture_percent / a.length, 0);
  const avgTemp = data.filter((n) => n.latest?.temperature_c != null)
    .reduce((s, n, _, a) => s + n.latest.temperature_c / a.length, 0);

  const SortIcon = ({ k }) => (
    <span style={styles.sortIcon}>{sortKey === k ? (sortDir === "asc" ? " ↑" : " ↓") : " ↕"}</span>
  );

  if (!ready) return null;
  return (
    <div style={styles.root}>
      <div style={styles.grain} />

      {/* ── Header ── */}
      <header style={styles.header}>
        <div style={styles.headerLeft}>
          <svg width="28" height="28" viewBox="0 0 28 28" fill="none">
            <path d="M14 2C7.37 2 2 7.37 2 14s5.37 12 12 12 12-5.37 12-12S20.63 2 14 2z"
                  fill="#2d7a4f22" stroke="#2d7a4f" strokeWidth="1.5"/>
            <path d="M14 6v8l5 3" stroke="#2d7a4f" strokeWidth="1.5" strokeLinecap="round"/>
            <circle cx="14" cy="14" r="2" fill="#2d7a4f"/>
          </svg>
          <div>
            <h1 style={styles.headerTitle}>IRRIGA<span style={styles.accent}>NET</span></h1>
            <p style={styles.headerSub}>Smart Field Management Console</p>
          </div>
        </div>

        <div style={styles.headerRight}>
          {lastUpdated && (
            <span style={styles.lastUpdated}>Last sync: {lastUpdated.toLocaleTimeString()}</span>
          )}

          <button onClick={refetch} style={styles.refreshBtn} disabled={loading}>
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor"
              strokeWidth="2.5" strokeLinecap="round"
              style={{ animation: loading ? "spin 1s linear infinite" : "none" }}>
              <path d="M23 4v6h-6M1 20v-6h6"/>
              <path d="M3.51 9a9 9 0 0114.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0020.49 15"/>
            </svg>
            {loading ? "Syncing…" : "Refresh"}
          </button>

          {/* User badge */}
          {user && (
            <div style={styles.userBadge}>
              <div style={styles.userAvatar}>
                {(user.name ?? user.email ?? "?")[0].toUpperCase()}
              </div>
              <div style={styles.userInfo}>
                <span style={styles.userName}>{user.name ?? user.email}</span>
                {user.role && (() => {
                  const c = roleBadgeColor(user.role);
                  return (
                    <span style={{ ...styles.userRole, background: c.bg, color: c.color, border: `1px solid ${c.border}` }}>
                      {user.role}
                    </span>
                  );
                })()}
              </div>
            </div>
          )}

          <button onClick={handleLogout} style={styles.logoutBtn}>
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor"
              strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M9 21H5a2 2 0 01-2-2V5a2 2 0 012-2h4"/>
              <polyline points="16 17 21 12 16 7"/>
              <line x1="21" y1="12" x2="9" y2="12"/>
            </svg>
            Sign Out
          </button>
        </div>
      </header>

      <main style={styles.main}>
        {/* ── Stat cards ── */}
        <div style={styles.statsRow}>
          <StatCard label="Total Nodes" value={data.length}      sub="registered"       />
          <StatCard label="Active"       value={activeCount}      sub={`of ${data.length}`} />
          <StatCard label="Alerts"       value={alertCount}       sub="below threshold"  />
          <StatCard label="Avg Moisture" value={fmt(avgMoisture)} unit="%" sub="across all nodes" />
          <StatCard label="Avg Temp"     value={fmt(avgTemp)}     unit="°C" sub="field average"  />
        </div>

        {/* ── Table card ── */}
        <div style={styles.card}>
          <div style={styles.toolbar}>
            <div style={styles.filterGroup}>
              {["all", "active", "inactive", "alert"].map(f => (
                <button key={f} onClick={() => setFilter(f)}
                  style={{ ...styles.filterBtn, ...(filter === f ? styles.filterBtnActive : {}) }}>
                  {f.charAt(0).toUpperCase() + f.slice(1)}
                </button>
              ))}
            </div>
            <span style={styles.rowCount}>{sorted.length} node{sorted.length !== 1 ? "s" : ""}</span>
          </div>

          {error && error !== "UNAUTHORIZED" && (
            <div style={styles.errorBanner}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <circle cx="12" cy="12" r="10"/>
                <line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>
              </svg>
              Failed to load nodes: {error}
            </div>
          )}

          <div style={styles.tableWrap}>
            <table style={styles.table}>
              <thead>
                <tr style={styles.thead}>
                  {[
                    { key: "location_name",         label: "Location"     },
                    { key: "node_id",               label: "Node ID"      },
                    { key: "crop_type",             label: "Crop"         },
                    { key: "soil_moisture_percent", label: "Moisture"     },
                    { key: "temperature_c",         label: "Temp"         },
                    { key: "humidity_percent",      label: "Humidity"     },
                    { key: "is_active",             label: "Status"       },
                    { key: "timestamp",             label: "Last Reading" },
                  ].map(col => (
                    <th key={col.key} style={styles.th} onClick={() => toggleSort(col.key)}>
                      {col.label}<SortIcon k={col.key} />
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {loading
                  ? Array.from({ length: 5 }).map((_, i) => <Skeleton key={i} />)
                  : sorted.length === 0
                  ? <tr><td colSpan={8} style={styles.emptyState}>No nodes match this filter.</td></tr>
                  : sorted.map((node, i) => (
                    <tr key={node.node_id}
                      style={{ ...styles.tr, ...(i % 2 === 0 ? styles.trEven : {}) }}>
                      <td style={styles.td}><span style={styles.locationName}>{node.location_name ?? "—"}</span></td>
                      <td style={styles.td}><code style={styles.nodeId}>{node.node_id}</code></td>
                      <td style={styles.td}><span style={styles.cropTag}>{node.crop_type ?? "—"}</span></td>
                      <td style={styles.td}>
                        <MoistureBar value={node.latest?.soil_moisture_percent} threshold={node.moisture_threshold_percent ?? 40} />
                      </td>
                      <td style={styles.td}><span style={styles.metric}>{fmt(node.latest?.temperature_c, "°C")}</span></td>
                      <td style={styles.td}><span style={styles.metric}>{fmt(node.latest?.humidity_percent, "%")}</span></td>
                      <td style={styles.td}>
                        <StatusBadge moisture={node.latest?.soil_moisture_percent} threshold={node.moisture_threshold_percent ?? 40} />
                      </td>
                      <td style={styles.td}><span style={styles.timeAgo}>{timeAgo(node.latest?.timestamp)}</span></td>
                    </tr>
                  ))
                }
              </tbody>
            </table>
          </div>

          <div style={styles.tableFooter}>
            <span style={styles.footerNote}>
              ◆ Threshold line on bars shows configured soil moisture limit. Auto-refreshes every 60 s.
            </span>
          </div>
        </div>
      </main>

      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Space+Mono:wght@400;700&family=Literata:wght@400;600&display=swap');
        * { box-sizing: border-box; margin: 0; padding: 0; }
        body { background: #f5f2eb; }
        @keyframes spin    { to { transform: rotate(360deg); } }
        @keyframes shimmer {
          0%   { background-position: -400px 0; }
          100% { background-position:  400px 0; }
        }
        ::-webkit-scrollbar { height: 6px; }
        ::-webkit-scrollbar-track { background: #e8e3d8; }
        ::-webkit-scrollbar-thumb { background: #b5ae9f; border-radius: 3px; }
      `}</style>
    </div>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────
const styles = {
  root: {
    minHeight: "100vh", background: "#f5f2eb",
    fontFamily: "'Literata', Georgia, serif", color: "#2a2820",
    position: "relative", overflow: "hidden",
  },
  grain: {
    position: "fixed", inset: 0, pointerEvents: "none", zIndex: 0,
    backgroundImage: `url("data:image/svg+xml,%3Csvg viewBox='0 0 256 256' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='4' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)' opacity='0.04'/%3E%3C/svg%3E")`,
  },
  header: {
    position: "relative", zIndex: 1, display: "flex", alignItems: "center",
    justifyContent: "space-between", padding: "16px 32px",
    borderBottom: "1px solid #d4cfc4", background: "#edeae0",
    gap: "16px", flexWrap: "wrap",
  },
  headerLeft:  { display: "flex", alignItems: "center", gap: "12px" },
  headerTitle: { fontFamily: "'Space Mono', monospace", fontSize: "22px", fontWeight: 700, letterSpacing: "0.12em", color: "#2a2820", lineHeight: 1 },
  accent:      { color: "#2d7a4f" },
  headerSub:   { fontFamily: "'Space Mono', monospace", fontSize: "10px", letterSpacing: "0.14em", textTransform: "uppercase", color: "#7a7568", marginTop: "4px" },
  headerRight: { display: "flex", alignItems: "center", gap: "12px", flexWrap: "wrap" },
  lastUpdated: { fontFamily: "'Space Mono', monospace", fontSize: "11px", color: "#7a7568" },
  refreshBtn: {
    display: "flex", alignItems: "center", gap: "6px", padding: "7px 13px",
    background: "#2d7a4f", color: "#fff", border: "none", borderRadius: "4px",
    fontFamily: "'Space Mono', monospace", fontSize: "11px", cursor: "pointer", letterSpacing: "0.05em",
  },
  userBadge: {
    display: "flex", alignItems: "center", gap: "8px", padding: "5px 10px",
    background: "#e2ddd2", border: "1px solid #d4cfc4", borderRadius: "4px",
  },
  userAvatar: {
    width: "26px", height: "26px", borderRadius: "50%", background: "#2d7a4f", color: "#fff",
    display: "flex", alignItems: "center", justifyContent: "center",
    fontFamily: "'Space Mono', monospace", fontSize: "11px", fontWeight: 700, flexShrink: 0,
  },
  userInfo:  { display: "flex", flexDirection: "column", gap: "2px" },
  userName:  { fontFamily: "'Space Mono', monospace", fontSize: "11px", color: "#2a2820", lineHeight: 1 },
  userRole:  { fontFamily: "'Space Mono', monospace", fontSize: "9px", letterSpacing: "0.1em", textTransform: "uppercase", padding: "1px 5px", borderRadius: "2px", lineHeight: 1.4, alignSelf: "flex-start" },
  logoutBtn: {
    display: "flex", alignItems: "center", gap: "6px", padding: "7px 13px",
    background: "transparent", color: "#7a7568", border: "1px solid #d4cfc4",
    borderRadius: "4px", fontFamily: "'Space Mono', monospace", fontSize: "11px",
    cursor: "pointer", letterSpacing: "0.05em",
  },
  main: {
    position: "relative", zIndex: 1, maxWidth: "1400px", margin: "0 auto",
    padding: "32px 32px 64px", display: "flex", flexDirection: "column", gap: "24px",
  },
  statsRow: { display: "grid", gridTemplateColumns: "repeat(5, 1fr)", gap: "12px" },
  statCard: { background: "#edeae0", border: "1px solid #d4cfc4", borderRadius: "6px", padding: "18px 20px", display: "flex", flexDirection: "column", gap: "4px" },
  statLabel: { fontFamily: "'Space Mono', monospace", fontSize: "10px", letterSpacing: "0.14em", textTransform: "uppercase", color: "#7a7568" },
  statValue: { fontFamily: "'Space Mono', monospace", fontSize: "28px", fontWeight: 700, color: "#2a2820", lineHeight: 1.1 },
  statUnit:  { fontSize: "14px", fontWeight: 400, color: "#7a7568", marginLeft: "2px" },
  statSub:   { fontSize: "11px", color: "#9a9488", fontFamily: "'Space Mono', monospace" },
  card:      { background: "#edeae0", border: "1px solid #d4cfc4", borderRadius: "8px", overflow: "hidden" },
  toolbar:   { display: "flex", alignItems: "center", justifyContent: "space-between", padding: "14px 20px", borderBottom: "1px solid #d4cfc4", background: "#e8e3d8" },
  filterGroup: { display: "flex", gap: "4px" },
  filterBtn: { padding: "5px 12px", border: "1px solid #d4cfc4", borderRadius: "3px", background: "transparent", fontFamily: "'Space Mono', monospace", fontSize: "11px", color: "#7a7568", cursor: "pointer", letterSpacing: "0.05em", transition: "all 0.15s" },
  filterBtnActive: { background: "#2d7a4f", borderColor: "#2d7a4f", color: "#fff" },
  rowCount: { fontFamily: "'Space Mono', monospace", fontSize: "11px", color: "#9a9488", letterSpacing: "0.05em" },
  errorBanner: { display: "flex", alignItems: "center", gap: "8px", padding: "12px 20px", background: "#fdf0ee", borderBottom: "1px solid #f0c4bc", color: "#c0392b", fontFamily: "'Space Mono', monospace", fontSize: "12px" },
  tableWrap: { overflowX: "auto" },
  table:     { width: "100%", borderCollapse: "collapse", fontSize: "13px" },
  thead:     { background: "#e2ddd2" },
  th:        { padding: "11px 16px", textAlign: "left", fontFamily: "'Space Mono', monospace", fontSize: "10px", letterSpacing: "0.12em", textTransform: "uppercase", color: "#7a7568", borderBottom: "1px solid #d4cfc4", cursor: "pointer", whiteSpace: "nowrap", userSelect: "none" },
  tr:        { transition: "background 0.1s", borderBottom: "1px solid #d4cfc4" },
  trEven:    { background: "#ebe7dc" },
  td:        { padding: "12px 16px", verticalAlign: "middle" },
  sortIcon:  { color: "#2d7a4f", fontSize: "10px" },
  locationName: { fontWeight: 600, fontSize: "13px", color: "#2a2820" },
  nodeId:    { fontFamily: "'Space Mono', monospace", fontSize: "11px", color: "#7a7568", background: "#ddd9ce", padding: "2px 6px", borderRadius: "3px" },
  cropTag:   { fontFamily: "'Space Mono', monospace", fontSize: "11px", color: "#2d7a4f", background: "#2d7a4f18", border: "1px solid #2d7a4f33", padding: "2px 8px", borderRadius: "2px", letterSpacing: "0.05em" },
  barWrap:   { display: "flex", alignItems: "center", gap: "8px", minWidth: "120px" },
  barTrack:  { flex: 1, height: "6px", background: "#d4cfc4", borderRadius: "3px", position: "relative", overflow: "visible" },
  barFill:   { height: "100%", borderRadius: "3px", transition: "width 0.4s ease" },
  barThreshold: { position: "absolute", top: "-3px", width: "2px", height: "12px", background: "#2a282080", borderRadius: "1px", transform: "translateX(-50%)" },
  barLabel:  { fontFamily: "'Space Mono', monospace", fontSize: "11px", fontWeight: 700, whiteSpace: "nowrap", minWidth: "36px" },
  metric:    { fontFamily: "'Space Mono', monospace", fontSize: "12px", color: "#4a4640" },
  badge:     { display: "inline-flex", alignItems: "center", gap: "5px", padding: "3px 9px", borderRadius: "3px", fontFamily: "'Space Mono', monospace", fontSize: "10px", fontWeight: 700, letterSpacing: "0.08em", whiteSpace: "nowrap" },
  badgeDot:  { width: "5px", height: "5px", borderRadius: "50%", flexShrink: 0 },
  timeAgo:   { fontFamily: "'Space Mono', monospace", fontSize: "11px", color: "#9a9488" },
  noData:    { fontFamily: "'Space Mono', monospace", color: "#b5ae9f" },
  emptyState:{ textAlign: "center", padding: "48px", fontFamily: "'Space Mono', monospace", fontSize: "13px", color: "#9a9488" },
  skeletonCell: { height: "14px", borderRadius: "3px", background: "linear-gradient(90deg, #ddd9ce 25%, #e8e3d8 50%, #ddd9ce 75%)", backgroundSize: "400px 100%", animation: "shimmer 1.4s infinite linear", width: "80%" },
  tableFooter: { padding: "10px 20px", borderTop: "1px solid #d4cfc4", background: "#e8e3d8" },
  footerNote: { fontFamily: "'Space Mono', monospace", fontSize: "10px", color: "#9a9488", letterSpacing: "0.05em" },
};