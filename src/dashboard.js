/**
 * Generates a self-contained, dependency-free dashboard HTML page for PM2 Monitor.
 */
export function renderDashboardHtml({ host, port }) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>PM2 Monitor Dashboard</title>
  <style>
    :root {
      --bg: #0f172a;
      --card-bg: #1e293b;
      --card-border: #334155;
      --text: #f8fafc;
      --text-muted: #94a3b8;
      --primary: #38bdf8;
      --success: #22c55e;
      --warning: #f59e0b;
      --danger: #ef4444;
      --neutral: #64748b;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      background: var(--bg);
      color: var(--text);
      line-height: 1.5;
      padding: 24px;
      min-height: 100vh;
    }
    .container { max-width: 1200px; margin: 0 auto; }
    header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      flex-wrap: wrap;
      gap: 16px;
      margin-bottom: 24px;
      padding-bottom: 16px;
      border-bottom: 1px solid var(--card-border);
    }
    .title-group { display: flex; align-items: center; gap: 12px; }
    .title-group h1 { font-size: 1.5rem; font-weight: 700; letter-spacing: -0.025em; }
    .badge-live {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      background: rgba(34, 197, 94, 0.15);
      color: var(--success);
      padding: 4px 10px;
      border-radius: 9999px;
      font-size: 0.75rem;
      font-weight: 600;
      text-transform: uppercase;
    }
    .badge-live::before {
      content: "";
      width: 6px;
      height: 6px;
      border-radius: 50%;
      background: var(--success);
      box-shadow: 0 0 8px var(--success);
    }
    .controls { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
    .btn {
      background: var(--card-bg);
      border: 1px solid var(--card-border);
      color: var(--text);
      padding: 8px 14px;
      border-radius: 6px;
      font-size: 0.875rem;
      font-weight: 500;
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      gap: 6px;
      transition: all 0.2s;
    }
    .btn:hover { background: #273548; border-color: #475569; }
    .btn-primary { background: #0284c7; border-color: #0284c7; }
    .btn-primary:hover { background: #0369a1; }
    .stats-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
      gap: 16px;
      margin-bottom: 24px;
    }
    .stat-card {
      background: var(--card-bg);
      border: 1px solid var(--card-border);
      padding: 16px;
      border-radius: 8px;
    }
    .stat-label { font-size: 0.8125rem; color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 4px; }
    .stat-value { font-size: 1.75rem; font-weight: 700; }
    .card {
      background: var(--card-bg);
      border: 1px solid var(--card-border);
      border-radius: 8px;
      overflow: hidden;
      margin-bottom: 24px;
    }
    .card-header {
      padding: 14px 20px;
      border-bottom: 1px solid var(--card-border);
      display: flex;
      justify-content: space-between;
      align-items: center;
      font-weight: 600;
    }
    table { width: 100%; border-collapse: collapse; text-align: left; font-size: 0.875rem; }
    th { padding: 12px 20px; background: rgba(0, 0, 0, 0.2); color: var(--text-muted); font-weight: 600; font-size: 0.75rem; text-transform: uppercase; }
    td { padding: 14px 20px; border-top: 1px solid var(--card-border); }
    tr:hover td { background: rgba(255, 255, 255, 0.02); }
    .status-badge {
      display: inline-block;
      padding: 3px 8px;
      border-radius: 4px;
      font-size: 0.75rem;
      font-weight: 600;
      text-transform: capitalize;
    }
    .status-online { background: rgba(34, 197, 94, 0.2); color: #4ade80; }
    .status-errored { background: rgba(239, 68, 68, 0.2); color: #f87171; }
    .status-stopped { background: rgba(100, 116, 139, 0.2); color: #94a3b8; }
    .status-other { background: rgba(245, 158, 11, 0.2); color: #fbbf24; }
    .progress-bar-bg {
      background: #334155;
      height: 6px;
      border-radius: 3px;
      overflow: hidden;
      margin-top: 6px;
      width: 100px;
    }
    .progress-bar-fill { height: 100%; background: var(--primary); transition: width 0.3s; }
    .progress-bar-fill.danger { background: var(--danger); }
    .app-name { font-weight: 600; color: var(--text); }
    .app-id { color: var(--text-muted); font-size: 0.75rem; margin-left: 6px; }
    .token-modal {
      display: none;
      position: fixed;
      inset: 0;
      background: rgba(0, 0, 0, 0.75);
      backdrop-filter: blur(4px);
      align-items: center;
      justify-content: center;
      z-index: 100;
    }
    .token-box {
      background: var(--card-bg);
      border: 1px solid var(--card-border);
      padding: 24px;
      border-radius: 8px;
      width: 100%;
      max-width: 400px;
    }
    .token-box h3 { margin-bottom: 12px; }
    .token-box input {
      width: 100%;
      padding: 10px 12px;
      background: #0f172a;
      border: 1px solid var(--card-border);
      border-radius: 6px;
      color: #fff;
      margin-bottom: 16px;
      font-size: 0.9375rem;
    }
    .token-actions { display: flex; justify-content: flex-end; gap: 8px; }
    #last-updated { font-size: 0.8125rem; color: var(--text-muted); }
  </style>
</head>
<body>
  <div class="container">
    <header>
      <div class="title-group">
        <h1>PM2 Monitor</h1>
        <span class="badge-live">Live</span>
      </div>
      <div class="controls">
        <span id="last-updated">Updating...</span>
        <button class="btn" id="btn-refresh">Refresh</button>
        <button class="btn" id="btn-token">Set Token</button>
      </div>
    </header>

    <div class="stats-grid">
      <div class="stat-card">
        <div class="stat-label">Total Processes</div>
        <div class="stat-value" id="stat-total">-</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Online</div>
        <div class="stat-value" style="color: var(--success);" id="stat-online">-</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Issues / Errors</div>
        <div class="stat-value" style="color: var(--danger);" id="stat-issues">-</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Restart Watches</div>
        <div class="stat-value" style="color: var(--warning);" id="stat-watches">-</div>
      </div>
    </div>

    <div class="card">
      <div class="card-header">
        <span>Processes</span>
      </div>
      <div style="overflow-x: auto;">
        <table id="proc-table">
          <thead>
            <tr>
              <th>App</th>
              <th>Status</th>
              <th>Restarts</th>
              <th>CPU</th>
              <th>Memory</th>
              <th>PID</th>
              <th>Uptime</th>
            </tr>
          </thead>
          <tbody id="proc-tbody">
            <tr><td colspan="7" style="text-align: center; color: var(--text-muted);">Loading processes...</td></tr>
          </tbody>
        </table>
      </div>
    </div>
  </div>

  <div class="token-modal" id="token-modal">
    <div class="token-box">
      <h3>Bearer Token Required</h3>
      <p style="font-size: 0.875rem; color: var(--text-muted); margin-bottom: 14px;">
        This monitor requires an authentication token to access status information.
      </p>
      <input type="password" id="token-input" placeholder="Enter STATUS_TOKEN" />
      <div class="token-actions">
        <button class="btn" id="token-cancel">Cancel</button>
        <button class="btn btn-primary" id="token-save">Save Token</button>
      </div>
    </div>
  </div>

  <script>
    const tokenModal = document.getElementById('token-modal');
    const tokenInput = document.getElementById('token-input');
    let autoRefreshTimer = null;

    function getToken() { return localStorage.getItem('pm2_status_token') || ''; }
    function setToken(val) {
      if (val) localStorage.setItem('pm2_status_token', val);
      else localStorage.removeItem('pm2_status_token');
    }

    function getAuthHeaders() {
      const token = getToken();
      return token ? { 'Authorization': 'Bearer ' + token } : {};
    }

    async function loadData() {
      try {
        const [statusRes, healthRes] = await Promise.all([
          fetch('/status/latest', { headers: getAuthHeaders() }),
          fetch('/healthz', { headers: getAuthHeaders() }),
        ]);

        if (statusRes.status === 401 || healthRes.status === 401) {
          tokenModal.style.display = 'flex';
          return;
        }

        const snapshot = await statusRes.json();
        const health = await healthRes.json();

        updateStats(snapshot, health);
        updateTable(snapshot ? snapshot.processes : []);
        document.getElementById('last-updated').textContent = 'Last check: ' + (health.lastCycleAt ? new Date(health.lastCycleAt).toLocaleTimeString() : 'None');
      } catch (err) {
        document.getElementById('last-updated').textContent = 'Fetch failed: ' + err.message;
      }
    }

    function updateStats(snapshot, health) {
      const procs = snapshot ? snapshot.processes || [] : [];
      document.getElementById('stat-total').textContent = procs.length;
      document.getElementById('stat-online').textContent = procs.filter(p => p.status === 'online').length;
      document.getElementById('stat-issues').textContent = procs.filter(p => p.status !== 'online').length;
      document.getElementById('stat-watches').textContent = (health.watchingRestarts || []).length;
    }

    function formatUptime(startedAt) {
      if (!startedAt) return '-';
      const sec = Math.max(0, Math.floor((Date.now() - startedAt) / 1000));
      if (sec < 60) return sec + 's';
      const min = Math.floor(sec / 60);
      if (min < 60) return min + 'm';
      const hrs = Math.floor(min / 60);
      return hrs + 'h ' + (min % 60) + 'm';
    }

    function updateTable(processes) {
      const tbody = document.getElementById('proc-tbody');
      if (!processes || processes.length === 0) {
        tbody.innerHTML = '<tr><td colspan="7" style="text-align: center; color: var(--text-muted);">No monitored processes found.</td></tr>';
        return;
      }

      tbody.innerHTML = processes.map(p => {
        let statusClass = 'status-other';
        if (p.status === 'online') statusClass = 'status-online';
        else if (p.status === 'errored') statusClass = 'status-errored';
        else if (p.status === 'stopped') statusClass = 'status-stopped';

        const cpuVal = p.cpu !== null ? p.cpu : 0;
        const cpuWidth = Math.min(100, Math.round(cpuVal));
        const memVal = p.memory !== null ? p.memory : 0;

        return \`<tr>
          <td><span class="app-name">\${escapeHtml(p.name)}</span><span class="app-id">#\${p.pm_id}</span></td>
          <td><span class="status-badge \${statusClass}">\${p.status}</span></td>
          <td>\${p.restarts > 0 ? '<strong style="color:var(--warning)">' + p.restarts + '</strong>' : '0'}</td>
          <td>
            \${p.cpu !== null ? p.cpu + '%' : 'unknown'}
            <div class="progress-bar-bg"><div class="progress-bar-fill \${cpuVal >= 80 ? 'danger' : ''}" style="width: \${cpuWidth}%"></div></div>
          </td>
          <td>\${p.memory !== null ? p.memory + ' MB' : 'unknown'}</td>
          <td style="color: var(--text-muted)">\${p.pid || '-'}</td>
          <td style="color: var(--text-muted)">\${formatUptime(p.uptimeStartedAt)}</td>
        </tr>\`;
      }).join('');
    }

    function escapeHtml(str) {
      return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    }

    document.getElementById('btn-refresh').onclick = loadData;
    document.getElementById('btn-token').onclick = () => {
      tokenInput.value = getToken();
      tokenModal.style.display = 'flex';
    };
    document.getElementById('token-cancel').onclick = () => { tokenModal.style.display = 'none'; };
    document.getElementById('token-save').onclick = () => {
      setToken(tokenInput.value.trim());
      tokenModal.style.display = 'none';
      loadData();
    };

    loadData();
    setInterval(loadData, 10000);
  </script>
</body>
</html>`;
}
