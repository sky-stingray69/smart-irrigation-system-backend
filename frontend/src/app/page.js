"use client";

import { useState, useEffect, useCallback } from "react";

const API_BASE = process.env.NEXT_PUBLIC_API_BASE ?? "http://localhost:5000";

// ─── Auth helpers ─────────────────────────────────────────────────────────────
function getToken()    { return typeof window !== "undefined" ? localStorage.getItem("irriga_token") : null; }
function getUser()     { try { return JSON.parse(localStorage.getItem("irriga_user") ?? "null"); } catch { return null; } }
function clearSession(){ localStorage.removeItem("irriga_token"); localStorage.removeItem("irriga_user"); }

function authHeaders(token) {
  return { "Content-Type": "application/json", Authorization: `Bearer ${token}` };
}

// ─── Node data hook ───────────────────────────────────────────────────────────
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
      const res = await fetch(`${API_BASE}/api/v1/portal/nodes`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (res.status === 401) throw new Error("UNAUTHORIZED");
      if (!res.ok)            throw new Error(`HTTP ${res.status}: ${res.statusText}`);
      const json = await res.json();
      setData(json.nodes ?? json);
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

// ─── Slave API helpers ────────────────────────────────────────────────────────
async function fetchSlaves(token, nodeId) {
  const res = await fetch(`${API_BASE}/api/v1/portal/nodes/${nodeId}/slaves`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`Failed to fetch slaves (${res.status})`);
  const json = await res.json();
  return json.slaves ?? [];
}

async function addSlave(token, nodeId, slaveId, angle) {
  const res = await fetch(`${API_BASE}/api/v1/portal/nodes/${nodeId}/slaves`, {
    method: "POST",
    headers: authHeaders(token),
    body: JSON.stringify({ slave_id: slaveId, angle }),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(json.error || "Failed to add slave");
  return json.slave;
}

async function updateSlaveAngle(token, nodeId, slaveId, angle) {
  const res = await fetch(`${API_BASE}/api/v1/portal/nodes/${nodeId}/slaves/${slaveId}`, {
    method: "PUT",
    headers: authHeaders(token),
    body: JSON.stringify({ angle }),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(json.error || "Failed to update slave");
  return json.slave;
}

async function deleteSlave(token, nodeId, slaveId) {
  const res = await fetch(`${API_BASE}/api/v1/portal/nodes/${nodeId}/slaves/${slaveId}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    const json = await res.json();
    throw new Error(json.error || "Failed to delete slave");
  }
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
  const barColor = value < threshold * 0.6 ? "#c0392b" : value < threshold ? "#e67e22" : "#2d7a4f";
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

// ─── Slave Manager (inside Edit modal) ───────────────────────────────────────
function SlaveManager({ token, nodeId, isAdmin }) {
  const [slaves, setSlaves]         = useState([]);
  const [loadingSlaves, setLoading] = useState(true);
  const [slaveError, setError]      = useState("");

  const [newSlaveId, setNewSlaveId] = useState("");
  const [newAngle, setNewAngle]     = useState("");
  const [addLoading, setAddLoading] = useState(false);

  const [editAngles, setEditAngles]   = useState({});
  const [savingId, setSavingId]       = useState(null);
  const [deletingId, setDeletingId]   = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const s = await fetchSlaves(token, nodeId);
      setSlaves(s);
      const angles = {};
      s.forEach(sl => { angles[sl.slave_id] = sl.angle; });
      setEditAngles(angles);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [token, nodeId]);

  useEffect(() => { load(); }, [load]);

  const handleAdd = async () => {
    const angle = Number(newAngle);
    if (!newSlaveId.trim()) return setError("Slave ID is required.");
    if (isNaN(angle) || angle < 0 || angle > 180) return setError("Angle must be 0–180.");
    setAddLoading(true);
    setError("");
    try {
      const s = await addSlave(token, nodeId, newSlaveId.trim(), angle);
      setSlaves(prev => [...prev, s]);
      setEditAngles(prev => ({ ...prev, [s.slave_id]: s.angle }));
      setNewSlaveId("");
      setNewAngle("");
    } catch (e) {
      setError(e.message);
    } finally {
      setAddLoading(false);
    }
  };

  const handleAngleSave = async (slaveId) => {
    const angle = Number(editAngles[slaveId]);
    if (isNaN(angle) || angle < 0 || angle > 180) return setError("Angle must be 0–180.");
    setSavingId(slaveId);
    setError("");
    try {
      const updated = await updateSlaveAngle(token, nodeId, slaveId, angle);
      setSlaves(prev => prev.map(s => s.slave_id === slaveId ? updated : s));
    } catch (e) {
      setError(e.message);
    } finally {
      setSavingId(null);
    }
  };

  const handleDelete = async (slaveId) => {
    if (!window.confirm(`Remove slave "${slaveId}"?`)) return;
    setDeletingId(slaveId);
    setError("");
    try {
      await deleteSlave(token, nodeId, slaveId);
      setSlaves(prev => prev.filter(s => s.slave_id !== slaveId));
      setEditAngles(prev => { const c = { ...prev }; delete c[slaveId]; return c; });
    } catch (e) {
      setError(e.message);
    } finally {
      setDeletingId(null);
    }
  };

  return (
    <div style={styles.slaveSection}>
      <div style={styles.slaveSectionHeader}>
        <span style={styles.slaveSectionTitle}>⚙ Slave Servos & Telemetry</span>
        <span style={styles.slaveCount}>{slaves.length} registered</span>
      </div>

      {slaveError && <div style={styles.slaveError}>{slaveError}</div>}

      {loadingSlaves ? (
        <div style={styles.slaveLoading}>Loading slaves…</div>
      ) : slaves.length === 0 ? (
        <div style={styles.slaveEmpty}>No slaves registered yet.</div>
      ) : (
        <div style={styles.slaveList}>
          <div style={styles.slaveRowHeader}>
            <span style={{ flex: 1.5 }}>Slave ID</span>
            <span style={{ flex: 2 }}>Current Moisture</span>
            <span style={{ flex: 1.5 }}>Last Seen</span>
            <span style={{ flex: 1 }}>Angle</span>
            {isAdmin && <span style={{ width: 80 }}></span>}
          </div>

          {slaves.map(sl => (
            <div key={sl.slave_id} style={styles.slaveRow}>
              <code style={{ ...styles.nodeId, flex: 1.5 }}>{sl.slave_id}</code>
              
              <div style={{ flex: 2 }}>
                <MoistureBar value={sl.latest_moisture} threshold={40} />
              </div>

              <span style={{ ...styles.timeAgo, flex: 1.5 }}>
                {timeAgo(sl.latest_timestamp)}
              </span>

              {isAdmin ? (
                <div style={{ flex: 1, display: "flex", alignItems: "center", gap: 4 }}>
                  <input
                    type="number"
                    min={0}
                    max={180}
                    value={editAngles[sl.slave_id] ?? sl.angle}
                    onChange={e => setEditAngles(prev => ({ ...prev, [sl.slave_id]: e.target.value }))}
                    style={styles.slaveAngleInput}
                  />
                  <button onClick={() => handleAngleSave(sl.slave_id)} disabled={savingId === sl.slave_id} style={styles.slaveSaveBtn}>
                    {savingId === sl.slave_id ? "…" : "✓"}
                  </button>
                </div>
              ) : (
                <span style={{ flex: 1, fontFamily: "'Space Mono', monospace" }}>{sl.angle}°</span>
              )}

              {isAdmin && (
                <button
                  onClick={() => handleDelete(sl.slave_id)}
                  disabled={deletingId === sl.slave_id}
                  style={{ ...styles.slaveDeleteBtn, marginLeft: 10 }}
                >
                  ✕
                </button>
              )}
            </div>
          ))}
        </div>
      )}

      {isAdmin && (
        <div style={styles.addSlaveForm}>
          <span style={styles.addSlaveLabel}>Add Slave</span>
          <div style={styles.addSlaveRow}>
            <input placeholder="slave-01" value={newSlaveId} onChange={e => setNewSlaveId(e.target.value)} style={{ ...styles.input, flex: 2 }} />
            <input type="number" placeholder="Angle" value={newAngle} onChange={e => setNewAngle(e.target.value)} style={{ ...styles.input, flex: 1 }} />
            <button onClick={handleAdd} disabled={addLoading} style={styles.addSlaveBtn}>
              {addLoading ? "…" : "+ Add"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Main Dashboard ───────────────────────────────────────────────────────────
export default function Home() {
  const [token, setToken] = useState(null);
  const [user, setUser]   = useState(null);
  const [ready, setReady] = useState(false);

  const [sortKey, setSortKey] = useState("location_name");
  const [sortDir, setSortDir] = useState("asc");
  const [filter, setFilter]   = useState("all");

  const [modalOpen, setModalOpen]     = useState(false);
  const [editingNode, setEditingNode] = useState(null);
  const [newApiKey, setNewApiKey]     = useState(null);
  const [formError, setFormError]     = useState("");
  const [formLoading, setFormLoading] = useState(false);

  const { data, loading, error, lastUpdated, refetch } = useNodeData(token);

  useEffect(() => {
    const t = getToken();
    const u = getUser();
    if (!t) { window.location.href = "/login"; return; }
    setToken(t);
    setUser(u);
    setReady(true);
  }, []);

  useEffect(() => {
    if (error === "UNAUTHORIZED") {
      clearSession();
      window.location.href = "/login";
    }
  }, [error]);

  const handleLogout = () => { clearSession(); window.location.href = "/login"; };

  const openCreate = () => { setEditingNode(null); setNewApiKey(null); setFormError(""); setModalOpen(true); };
  const openEdit   = (node) => { setEditingNode(node); setNewApiKey(null); setFormError(""); setModalOpen(true); };
  const closeModal = () => { setModalOpen(false); setEditingNode(null); setNewApiKey(null); setFormError(""); };

  const handleSaveNode = async (e) => {
    e.preventDefault();
    setFormError("");
    setFormLoading(true);
    const fd = new FormData(e.target);
    console.log(fd.get("is_active"))
    const payload = {
      node_id:                        fd.get("node_id"),
      location_name:                  fd.get("location_name"),
      crop_type:                      fd.get("crop_type"),
      moisture_threshold_percent:     Number(fd.get("moisture_threshold")),
      irrigation_rate_liters_per_min: Number(fd.get("irrigation_rate")),
      coordinates:                    {
      lat: Number(fd.get("lattitude")),
      lon: Number(fd.get("longitude"))
      },
      ...(editingNode ? { is_active: fd.get("is_active") === "on" } : {}),
    };

    try {
      const url    = editingNode
        ? `${API_BASE}/api/v1/portal/nodes/${editingNode.node_id}`
        : `${API_BASE}/api/v1/portal/nodes`;
      const method = editingNode ? "PUT" : "POST";
      console.log("📤 Sending request:", { method, url, payload });
      const res  = await fetch(url, { method, headers: authHeaders(token), body: JSON.stringify(payload) });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Operation failed");

      if (json.api_key) {
        setNewApiKey({ key: json.api_key, node_id: json.node_id });
      } else {
        closeModal();
        refetch();
      }
    } catch (err) {
      setFormError(err.message);
    } finally {
      setFormLoading(false);
    }
  };

  const filtered = (data || []).filter((n) => {
    if (filter === "active")   return n.is_active;
    if (filter === "inactive") return !n.is_active;
    if (filter === "alert")    return n.latest && n.latest.soil_moisture_percent < n.moisture_threshold_percent;
    return true;
  });

  const sorted = [...filtered].sort((a, b) => {
    let va = a[sortKey] ?? a.latest?.[sortKey] ?? "";
    let vb = b[sortKey] ?? b.latest?.[sortKey] ?? "";
    if (typeof va === "string") va = va.toLowerCase();
    if (typeof vb === "string") vb = vb.toLowerCase();
    return sortDir === "asc" ? (va > vb ? 1 : -1) : (va < vb ? 1 : -1);
  });

  const isAdmin = user?.role === "admin";

  if (!ready) return null;

  return (
    <div style={styles.root}>
      <div style={styles.grain} />

      <header style={styles.header}>
        <div style={styles.headerLeft}>
          <div style={styles.logoBox}>
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#2d7a4f" strokeWidth="2">
              <path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5" />
            </svg>
          </div>
          <div>
            <h1 style={styles.headerTitle}>IRRIGA<span style={styles.accent}>NET</span></h1>
            <p style={styles.headerSub}>Smart Field Console</p>
          </div>
        </div>
        <div style={styles.headerRight}>
          {isAdmin && (
            <button onClick={openCreate} style={styles.addBtn}>+ Register Node</button>
          )}
          <button onClick={handleLogout} style={styles.logoutBtn}>Sign Out</button>
        </div>
      </header>

      <main style={styles.main}>
        <div style={styles.statsRow}>
          <StatCard label="Total Nodes"  value={data.length} sub="in network" />
          <StatCard label="Live Nodes"   value={data.filter(n => n.is_active).length} sub="broadcasting" />
          <StatCard
            label="Avg Moisture"
            value={fmt(data.reduce((a, n) => a + (n.latest?.soil_moisture_percent || 0), 0) / (data.length || 1))}
            unit="%" sub="system average"
          />
        </div>

        <div style={styles.card}>
          <div style={styles.toolbar}>
            <div style={styles.filterGroup}>
              {["all", "active", "inactive", "alert"].map(f => (
                <button key={f} onClick={() => setFilter(f)}
                  style={{ ...styles.filterBtn, ...(filter === f ? styles.filterBtnActive : {}) }}>
                  {f.toUpperCase()}
                </button>
              ))}
            </div>
            {lastUpdated && <span style={styles.syncText}>Last sync: {lastUpdated.toLocaleTimeString()}</span>}
          </div>

          <div style={styles.tableWrap}>
            <table style={styles.table}>
              <thead>
                <tr style={styles.thead}>
                  <th style={styles.th}>Location</th>
                  <th style={styles.th}>Node ID</th>
                  <th style={styles.th}>Zone Breakdowns (Slave ID | Moisture | Last Seen)</th>
                  <th style={styles.th}>Manage</th>
                </tr>
              </thead>
              <tbody>
                {sorted.map((node, i) => (
                  <tr key={node.node_id} style={{ ...styles.tr, ...(i % 2 === 0 ? styles.trEven : {}) }}>
                    <td style={styles.td}>
                        <span style={styles.locationName}>{node.location_name}</span>
                        <div style={styles.cropTag}>{node.crop_type}</div>
                    </td>
                    <td style={styles.td}><code style={styles.nodeId}>{node.node_id}</code></td>
                    
                    {/* SLAVE DETAIL COLUMN */}
                    <td style={styles.td}>
                      <div style={styles.slaveSummaryList}>
                        {node.slaves && node.slaves.length > 0 ? (
                          node.slaves.map(slave => (
                            <div key={slave.slave_id} style={styles.slaveSummaryRow}>
                                <code style={styles.slaveIdMini}>{slave.slave_id}</code>
                                <div style={{ width: 120 }}>
                                    <MoistureBar value={slave.latest_moisture} threshold={node.moisture_threshold_percent} />
                                </div>
                                <span style={styles.timeAgoMini}>{timeAgo(slave.latest_timestamp)}</span>
                            </div>
                          ))
                        ) : (
                          <span style={styles.noSlaves}>No slaves connected.</span>
                        )}
                      </div>
                    </td>

                    <td style={styles.td}>
                      <button onClick={() => openEdit(node)} style={styles.editBtn}>
                        {isAdmin ? "Edit" : "View"}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </main>

      {/* Modal remains visually identical, calls updated SlaveManager */}
      {modalOpen && (
        <div style={styles.modalOverlay} onClick={(e) => e.target === e.currentTarget && closeModal()}>
          <div style={styles.modal}>
            <div style={styles.modalHeader}>
              <h2 style={styles.modalTitle}>
                {newApiKey ? "API Key Generated" : editingNode ? `Configure: ${editingNode.node_id}` : "Register New Node"}
              </h2>
              <button onClick={closeModal} style={styles.closeBtn}>&times;</button>
            </div>

            {newApiKey ? (
              <div style={styles.apiKeyContainer}>
                <p style={styles.apiKeyWarning}>
                  <strong>ONE-TIME VIEW:</strong> Copy and flash this key to your ESP32 now.
                </p>
                <div style={styles.keyBox}>{newApiKey.key}</div>
                <div style={{ borderTop: "1px solid #d4cfc4", marginTop: 20, paddingTop: 20 }}>
                  <SlaveManager token={token} nodeId={newApiKey.node_id} isAdmin={true} />
                </div>
                <button onClick={() => { closeModal(); refetch(); }} style={{ ...styles.saveBtn, marginTop: 20, width: "100%" }}>
                  Done
                </button>
              </div>
            ) : (
              <>
                <form onSubmit={handleSaveNode} style={styles.form}>
                  <div style={styles.formGrid}>
                    <div style={styles.field}>
                      <label style={styles.label}>Node ID</label>
                      <input name="node_id" defaultValue={editingNode?.node_id} disabled={!!editingNode} style={{ ...styles.input, ...(editingNode ? styles.inputDisabled : {}) }} required />
                    </div>
                    {editingNode && (
                      <div style={{ ...styles.field, gridColumn: "span 2" }}>
                        <label style={{ ...styles.label, display: "flex", alignItems: "center", gap: 8, fontWeight: 400 }}>
                          <input 
                            type="checkbox" 
                            name="is_active" 
                            defaultChecked={editingNode?.is_active}
                            style={{ width: 16, height: 16, cursor: "pointer" }}
                          />
                          Active Node
                        </label>
                      </div>
                    )}
                    <div style={styles.field}>
                      <label style={styles.label}>Location</label>
                      <input name="location_name" defaultValue={editingNode?.location_name} style={styles.input} required />
                    </div>
                    <div style={styles.field}>
                      <label style={styles.label}>Crop Type</label>
                      <input name="crop_type" defaultValue={editingNode?.crop_type} style={styles.input} required />
                    </div>
                    <div style={styles.field}>
                        <label style={styles.label}>Threshold (%)</label>
                        <input type="number" name="moisture_threshold" defaultValue={editingNode?.moisture_threshold_percent ?? 40} style={styles.input} required />
                    </div>
                    <div style={styles.field}>
                        <label style={styles.label}>lattitude</label>
                        <input type="number" name="lattitude" defaultValue={editingNode?.lattitude ?? 40} style={styles.input} required />
                    </div>
                    <div style={styles.field}>
                        <label style={styles.label}>longitude</label>
                        <input type="number" name="longitude" defaultValue={editingNode?.longitude ?? 40} style={styles.input} required />
                    </div>
                  </div>

                  {formError && <div style={styles.formError}>{formError}</div>}

                  <div style={styles.modalFooter}>
                    <button type="button" onClick={closeModal} style={styles.cancelBtn}>Cancel</button>
                    <button type="submit" disabled={formLoading || !isAdmin} style={styles.saveBtn}>
                        {editingNode ? "Update" : "Create"}
                    </button>
                  </div>
                </form>

                {editingNode && (
                  <div style={{ borderTop: "1px solid #d4cfc4" }}>
                    <SlaveManager token={token} nodeId={editingNode.node_id} isAdmin={isAdmin} />
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ─── STYLES (Added New Slave Rows Styles) ───────────────────────────────────
const styles = {
  // ... Keep existing styles ...
  slaveSummaryList: { display: "flex", flexDirection: "column", gap: 8 },
  slaveSummaryRow: { display: "flex", alignItems: "center", gap: 12, padding: "4px 0" },
  slaveIdMini: { fontSize: 11, background: "#dfddd4", padding: "2px 6px", borderRadius: 4, fontFamily: "'Space Mono'", minWidth: 80 },
  timeAgoMini: { fontSize: 11, color: "#6b6b5c", fontStyle: "italic" },
  noSlaves: { fontSize: 12, color: "#999", fontStyle: "italic" },
  // Ensure table can handle the breakdown column
  tableWrap: { overflowX: "auto", background: "#fbf9f4" },
  // ... Append to existing styles ...
  root: { position: "relative", minHeight: "100vh", paddingBottom: 60, fontFamily: "'Literata', serif", color: "#2c2c24", overflowX: "hidden" },
  grain: { position: "fixed", top: 0, left: 0, width: "100%", height: "100%", pointerEvents: "none", opacity: 0.04, background: "url('https://www.transparenttextures.com/patterns/p6.png')", zIndex: 1000 },
  header: { display: "flex", justifyContent: "space-between", alignItems: "center", padding: "24px 40px", borderBottom: "1px solid #d4cfc4" },
  headerLeft: { display: "flex", alignItems: "center", gap: 16 },
  logoBox: { width: 44, height: 44, display: "flex", alignItems: "center", justifyContent: "center", border: "1.5px solid #2d7a4f", borderRadius: 8 },
  headerTitle: { fontSize: 22, fontWeight: 700, letterSpacing: 2, fontFamily: "'Space Mono'" },
  accent: { color: "#2d7a4f" },
  headerSub: { fontSize: 12, color: "#6b6b5c", textTransform: "uppercase", letterSpacing: 1 },
  headerRight: { display: "flex", gap: 12 },
  addBtn: { background: "#2d7a4f", color: "#fff", border: "none", padding: "10px 20px", borderRadius: 6, cursor: "pointer", fontWeight: 600, fontSize: 13 },
  logoutBtn: { background: "none", border: "1px solid #d4cfc4", color: "#6b6b5c", padding: "10px 16px", borderRadius: 6, cursor: "pointer", fontSize: 13 },
  main: { padding: "40px", maxWidth: 1400, margin: "0 auto" },
  statsRow: { display: "flex", gap: 24, marginBottom: 40 },
  statCard: { flex: 1, background: "#fff", padding: "24px", borderRadius: 12, border: "1px solid #d4cfc4", display: "flex", flexDirection: "column", gap: 4, boxShadow: "0 4px 6px -1px rgba(0,0,0,0.05)" },
  statLabel: { fontSize: 12, color: "#6b6b5c", fontWeight: 600, textTransform: "uppercase" },
  statValue: { fontSize: 32, fontWeight: 700, fontFamily: "'Space Mono'" },
  statUnit: { fontSize: 16, marginLeft: 4, color: "#6b6b5c" },
  statSub: { fontSize: 11, color: "#9a9a8c" },
  card: { background: "#fff", borderRadius: 12, border: "1px solid #d4cfc4", overflow: "hidden", boxShadow: "0 10px 15px -3px rgba(0,0,0,0.05)" },
  toolbar: { padding: "20px 24px", display: "flex", justifyContent: "space-between", alignItems: "center", background: "#fbf9f4", borderBottom: "1px solid #d4cfc4" },
  filterGroup: { display: "flex", gap: 8 },
  filterBtn: { background: "none", border: "1px solid #d4cfc4", color: "#6b6b5c", padding: "6px 14px", borderRadius: 20, cursor: "pointer", fontSize: 11, fontWeight: 700, transition: "0.2s" },
  filterBtnActive: { background: "#2d7a4f", color: "#fff", borderColor: "#2d7a4f" },
  syncText: { fontSize: 12, color: "#9a9a8c" },
  table: { width: "100%", borderCollapse: "collapse", textAlign: "left" },
  thead: { background: "#f5f2eb", borderBottom: "1.5px solid #d4cfc4" },
  th: { padding: "16px 24px", fontSize: 12, color: "#6b6b5c", fontWeight: 700, textTransform: "uppercase" },
  tr: { borderBottom: "1px solid #eee", transition: "0.2s" },
  trEven: { background: "#faf9f6" },
  td: { padding: "16px 24px", verticalAlign: "middle" },
  locationName: { fontSize: 15, fontWeight: 600, display: "block" },
  nodeId: { fontSize: 12, color: "#2d7a4f", fontFamily: "'Space Mono'", background: "#f0f7f3", padding: "2px 6px", borderRadius: 4 },
  cropTag: { fontSize: 11, color: "#6b6b5c", marginTop: 4 },
  badge: { display: "inline-flex", alignItems: "center", gap: 6, padding: "4px 10px", borderRadius: 12, fontSize: 11, fontWeight: 700 },
  badgeDot: { width: 6, height: 6, borderRadius: "50%" },
  editBtn: { background: "none", border: "1px solid #d4cfc4", padding: "6px 12px", borderRadius: 6, cursor: "pointer", fontSize: 12, fontWeight: 600 },
  barWrap: { display: "flex", alignItems: "center", gap: 10 },
  barTrack: { width: 80, height: 6, background: "#eee", borderRadius: 3, position: "relative" },
  barFill: { height: "100%", borderRadius: 3, transition: "0.4s ease-out" },
  barThreshold: { position: "absolute", top: -2, width: 2, height: 10, background: "#2c2c24", opacity: 0.3 },
  barLabel: { fontSize: 13, fontWeight: 700, fontFamily: "'Space Mono'", minWidth: 40 },
  modalOverlay: { position: "fixed", top: 0, left: 0, width: "100%", height: "100%", background: "rgba(44, 44, 36, 0.6)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 2000, padding: 20 },
  modal: { background: "#fff", width: "100%", maxWidth: 650, borderRadius: 16, overflowY: "auto", maxHeight: "90vh", boxShadow: "0 25px 50px -12px rgba(0,0,0,0.25)" },
  modalHeader: { padding: "24px", borderBottom: "1px solid #eee", display: "flex", justifyContent: "space-between", alignItems: "center" },
  modalTitle: { fontSize: 18, fontWeight: 700 },
  closeBtn: { background: "none", border: "none", fontSize: 24, cursor: "pointer", color: "#9a9a8c" },
  form: { padding: "24px" },
  formGrid: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: 20 },
  field: { display: "flex", flexDirection: "column", gap: 8 },
  label: { fontSize: 12, fontWeight: 700, color: "#6b6b5c" },
  input: { padding: "10px 14px", borderRadius: 8, border: "1px solid #d4cfc4", fontSize: 14, fontFamily: "inherit" },
  inputDisabled: { background: "#f5f5f5", cursor: "not-allowed" },
  modalFooter: { padding: "24px", borderTop: "1px solid #eee", display: "flex", justifyContent: "flex-end", gap: 12 },
  cancelBtn: { background: "none", border: "1px solid #d4cfc4", padding: "10px 20px", borderRadius: 8, cursor: "pointer", fontWeight: 600 },
  saveBtn: { background: "#2d7a4f", color: "#fff", border: "none", padding: "10px 24px", borderRadius: 8, cursor: "pointer", fontWeight: 600 },
  apiKeyContainer: { padding: "24px" },
  apiKeyWarning: { background: "#fff8e6", border: "1px solid #ffeeba", padding: "16px", borderRadius: 8, fontSize: 13, color: "#856404", marginBottom: 20 },
  keyBox: { background: "#2c2c24", color: "#fff", padding: "16px", borderRadius: 8, fontFamily: "'Space Mono'", fontSize: 16, textAlign: "center", wordBreak: "break-all" },
  slaveSection: { padding: "24px", background: "#fbf9f4" },
  slaveSectionHeader: { display: "flex", justifyContent: "space-between", marginBottom: 16 },
  slaveSectionTitle: { fontSize: 14, fontWeight: 700, textTransform: "uppercase", color: "#6b6b5c" },
  slaveCount: { fontSize: 12, color: "#9a9a8c" },
  slaveList: { display: "flex", flexDirection: "column", gap: 8, marginBottom: 20 },
  slaveRowHeader: { display: "flex", padding: "8px 12px", fontSize: 11, fontWeight: 700, color: "#9a9a8c", textTransform: "uppercase" },
  slaveRow: { display: "flex", alignItems: "center", padding: "12px", background: "#fff", borderRadius: 8, border: "1px solid #d4cfc4" },
  slaveAngleInput: { width: 50, padding: "4px", borderRadius: 4, border: "1px solid #d4cfc4", fontSize: 12 },
  slaveSaveBtn: { background: "#2d7a4f", color: "#fff", border: "none", padding: "4px 8px", borderRadius: 4, cursor: "pointer" },
  slaveDeleteBtn: { background: "none", color: "#c0392b", border: "none", fontSize: 14, cursor: "pointer" },
  addSlaveForm: { borderTop: "1px dashed #d4cfc4", paddingTop: 16 },
  addSlaveLabel: { fontSize: 12, fontWeight: 700, display: "block", marginBottom: 8 },
  addSlaveRow: { display: "flex", gap: 8 },
  addSlaveBtn: { background: "#2c2c24", color: "#fff", border: "none", padding: "0 16px", borderRadius: 8, cursor: "pointer", fontSize: 13 },

// ─── Styles ───────────────────────────────────────────────────────────────────

  root: { minHeight: "100vh", fontFamily: "'Literata', serif", color: "#2a2820", position: "relative" },
  grain: { position: "fixed", inset: 0, pointerEvents: "none", opacity: 0.04, backgroundImage: `url("data:image/svg+xml,%3Csvg viewBox='0 0 256 256' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='4' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E")` },
  header: { display: "flex", justifyContent: "space-between", alignItems: "center", padding: "16px 32px", background: "#edeae0", borderBottom: "1px solid #d4cfc4" },
  headerLeft: { display: "flex", alignItems: "center", gap: "12px" },
  logoBox: { padding: "6px", background: "#2d7a4f15", borderRadius: "6px", border: "1px solid #2d7a4f33" },
  headerTitle: { fontFamily: "'Space Mono', monospace", fontSize: "20px", fontWeight: 700, letterSpacing: "0.1em" },
  accent: { color: "#2d7a4f" },
  headerSub: { fontSize: "10px", textTransform: "uppercase", letterSpacing: "0.15em", color: "#7a7568", fontFamily: "'Space Mono', monospace" },
  headerRight: { display: "flex", gap: "12px" },
  addBtn: { padding: "8px 16px", background: "#2d7a4f", color: "#fff", border: "none", borderRadius: "4px", cursor: "pointer", fontFamily: "'Space Mono', monospace", fontSize: "11px" },
  logoutBtn: { padding: "8px 16px", background: "transparent", border: "1px solid #d4cfc4", borderRadius: "4px", cursor: "pointer", fontFamily: "'Space Mono', monospace", fontSize: "11px", color: "#7a7568" },
  main: { maxWidth: "1200px", margin: "0 auto", padding: "32px", display: "flex", flexDirection: "column", gap: "24px" },
  statsRow: { display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: "16px" },
  statCard: { background: "#edeae0", padding: "20px", borderRadius: "8px", border: "1px solid #d4cfc4" },
  statLabel: { display: "block", fontSize: "10px", fontFamily: "'Space Mono', monospace", textTransform: "uppercase", color: "#7a7568", marginBottom: "8px" },
  statValue: { fontSize: "28px", fontWeight: 700, fontFamily: "'Space Mono', monospace" },
  statUnit: { fontSize: "14px", marginLeft: "4px", color: "#7a7568" },
  statSub: { display: "block", fontSize: "11px", color: "#9a9488", marginTop: "4px" },
  card: { background: "#edeae0", border: "1px solid #d4cfc4", borderRadius: "8px", overflow: "hidden" },
  toolbar: { padding: "12px 20px", background: "#e8e3d8", display: "flex", justifyContent: "space-between", alignItems: "center", borderBottom: "1px solid #d4cfc4" },
  filterGroup: { display: "flex", gap: "4px" },
  filterBtn: { padding: "4px 12px", border: "1px solid #d4cfc4", background: "transparent", fontSize: "10px", fontFamily: "'Space Mono', monospace", cursor: "pointer", borderRadius: "3px" },
  filterBtnActive: { background: "#2d7a4f", color: "#fff", borderColor: "#2d7a4f" },
  syncText: { fontSize: "10px", color: "#7a7568", fontFamily: "'Space Mono', monospace" },
  tableWrap: { overflowX: "auto" },
  table: { width: "100%", borderCollapse: "collapse", textAlign: "left" },
  thead: { background: "#e2ddd2" },
  th: { padding: "12px 16px", fontSize: "10px", fontFamily: "'Space Mono', monospace", textTransform: "uppercase", letterSpacing: "0.05em", color: "#7a7568" },
  td: { padding: "14px 16px", fontSize: "13px", borderBottom: "1px solid #d4cfc4" },
  tr: {},
  trEven: { background: "#ebe7dc" },
  locationName: {},
  nodeId: { padding: "2px 6px", background: "#ddd9ce", borderRadius: "3px", fontSize: "11px", fontFamily: "'Space Mono', monospace" },
  cropTag: { color: "#2d7a4f", fontWeight: 600 },
  slavePill: { display: "inline-flex", alignItems: "center", padding: "2px 8px", background: "#2d7a4f18", border: "1px solid #2d7a4f44", borderRadius: "3px", fontFamily: "'Space Mono', monospace", fontSize: "11px", color: "#2d7a4f", fontWeight: 700 },
  slavePillLabel: { fontWeight: 400, opacity: 0.8 },
  editBtn: { background: "none", border: "none", color: "#2d7a4f", textDecoration: "underline", cursor: "pointer", fontSize: "11px", fontFamily: "'Space Mono', monospace" },
  timeAgo: { color: "#9a9488", fontSize: "11px" },
  modalOverlay: { position: "fixed", inset: 0, background: "rgba(0,0,0,0.5)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 100, padding: "20px" },
  modal: { background: "#f5f2eb", width: "100%", maxWidth: "560px", maxHeight: "90vh", overflowY: "auto", borderRadius: "8px", border: "1px solid #d4cfc4" },
  modalHeader: { padding: "16px 20px", background: "#edeae0", borderBottom: "1px solid #d4cfc4", display: "flex", justifyContent: "space-between", alignItems: "center", position: "sticky", top: 0, zIndex: 1 },
  modalTitle: { fontSize: "14px", fontFamily: "'Space Mono', monospace" },
  closeBtn: { background: "none", border: "none", fontSize: "20px", cursor: "pointer", color: "#7a7568" },
  form: { padding: "24px" },
  formGrid: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: "16px" },
  field: { display: "flex", flexDirection: "column", gap: "4px" },
  label: { fontSize: "10px", fontFamily: "'Space Mono', monospace", textTransform: "uppercase", color: "#7a7568" },
  input: { padding: "8px", border: "1px solid #d4cfc4", borderRadius: "4px", fontSize: "13px", background: "#fff", fontFamily: "inherit" },
  inputDisabled: { background: "#e8e3d8", color: "#7a7568" },
  modalFooter: { paddingTop: "20px", display: "flex", justifyContent: "flex-end", gap: "10px" },
  saveBtn: { padding: "10px 20px", background: "#2d7a4f", color: "#fff", border: "none", borderRadius: "4px", cursor: "pointer", fontFamily: "'Space Mono', monospace", fontSize: "11px" },
  cancelBtn: { padding: "10px 20px", background: "transparent", border: "1px solid #d4cfc4", borderRadius: "4px", cursor: "pointer", fontFamily: "'Space Mono', monospace", fontSize: "11px" },
  formError: { color: "#c0392b", fontSize: "11px", marginTop: "12px", fontFamily: "'Space Mono', monospace", gridColumn: "span 2" },
  apiKeyContainer: { padding: "24px" },
  keyBox: { padding: "16px", background: "#fff", border: "1px dashed #2d7a4f", borderRadius: "4px", margin: "16px 0", fontFamily: "'Space Mono', monospace", wordBreak: "break-all", fontSize: "12px" },
  apiKeyWarning: { color: "#c0392b", fontSize: "11px", fontFamily: "'Space Mono', monospace", lineHeight: 1.6 },
  barWrap: { display: "flex", alignItems: "center", gap: "8px", minWidth: "100px" },
  barTrack: { flex: 1, height: "6px", background: "#d4cfc4", borderRadius: "3px", position: "relative" },
  barFill: { height: "100%", borderRadius: "3px", transition: "width 0.5s ease" },
  barThreshold: { position: "absolute", top: "-3px", width: "2px", height: "12px", background: "#2a282080" },
  barLabel: { fontSize: "11px", fontFamily: "'Space Mono', monospace", width: "35px" },
  badge: { display: "inline-flex", alignItems: "center", gap: "4px", padding: "2px 8px", borderRadius: "3px", fontSize: "10px", fontFamily: "'Space Mono', monospace", fontWeight: 700 },
  badgeDot: { width: "4px", height: "4px", borderRadius: "50%" },
  noData: { color: "#9a9488", fontFamily: "'Space Mono', monospace" },

  // ── Slave section styles ──
  slaveSection: { padding: "20px 24px 24px" },
  slaveSectionHeader: { display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "12px" },
  slaveSectionTitle: { fontFamily: "'Space Mono', monospace", fontSize: "11px", textTransform: "uppercase", letterSpacing: "0.08em", color: "#7a7568" },
  slaveCount: { fontFamily: "'Space Mono', monospace", fontSize: "10px", background: "#2d7a4f18", color: "#2d7a4f", padding: "2px 8px", borderRadius: "3px", border: "1px solid #2d7a4f33" },
  slaveLoading: { fontSize: "12px", color: "#9a9488", fontFamily: "'Space Mono', monospace", padding: "12px 0" },
  slaveEmpty: { fontSize: "12px", color: "#9a9488", fontFamily: "'Space Mono', monospace", padding: "12px 0", fontStyle: "italic" },
  slaveError: { color: "#c0392b", fontSize: "11px", fontFamily: "'Space Mono', monospace", marginBottom: "10px" },
  slaveList: { border: "1px solid #d4cfc4", borderRadius: "4px", overflow: "hidden", marginBottom: "16px" },
  slaveRowHeader: { display: "flex", alignItems: "center", gap: "12px", padding: "6px 12px", background: "#e2ddd2", fontSize: "9px", fontFamily: "'Space Mono', monospace", textTransform: "uppercase", color: "#7a7568" },
  slaveRow: { display: "flex", alignItems: "center", gap: "12px", padding: "10px 12px", borderBottom: "1px solid #d4cfc4", background: "#fff" },
  slaveAngleInput: { width: "64px", padding: "4px 6px", border: "1px solid #d4cfc4", borderRadius: "3px", fontFamily: "'Space Mono', monospace", fontSize: "13px", background: "#f5f2eb" },
  slaveAngleUnit: { fontSize: "11px", color: "#7a7568", fontFamily: "'Space Mono', monospace" },
  slaveSaveBtn: { padding: "4px 10px", background: "#2d7a4f", color: "#fff", border: "none", borderRadius: "3px", cursor: "pointer", fontFamily: "'Space Mono', monospace", fontSize: "10px" },
  slaveDeleteBtn: { padding: "4px 8px", background: "transparent", color: "#c0392b", border: "1px solid #c0392b55", borderRadius: "3px", cursor: "pointer", fontFamily: "'Space Mono', monospace", fontSize: "11px" },
  addSlaveForm: { background: "#edeae0", border: "1px solid #d4cfc4", borderRadius: "4px", padding: "12px" },
  addSlaveLabel: { display: "block", fontSize: "9px", fontFamily: "'Space Mono', monospace", textTransform: "uppercase", color: "#7a7568", marginBottom: "8px" },
  addSlaveRow: { display: "flex", gap: "8px", alignItems: "center" },
  addSlaveBtn: { padding: "8px 14px", background: "#2d7a4f", color: "#fff", border: "none", borderRadius: "4px", cursor: "pointer", fontFamily: "'Space Mono', monospace", fontSize: "10px", whiteSpace: "nowrap" },
};