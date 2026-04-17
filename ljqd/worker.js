// ========== NewAPI 多账号签到（余额验证 + TG推送 + Web面板）==========
// 环境变量：
//   ACCOUNTS_JSON     - 账号列表 JSON（必填）
//   PANEL_PASSWORD    - 面板登录密码（必填）
//   TGTOKEN           - Telegram Bot Token（可选）
//   TGID              - Telegram Chat ID（可选）
// =========================================================================

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === "/") {
      return new Response(getHtmlTemplate(), {
        headers: { "Content-Type": "text/html;charset=UTF-8" },
      });
    }

    if (url.pathname.startsWith("/api/")) {
      return handleApiRequest(request, env, url.pathname);
    }

    // 直接通过密码路径触发签到（用于无面板调试）
    if (env.PANEL_PASSWORD && url.pathname === `/${env.PANEL_PASSWORD}`) {
      const result = await runAllCheckins(env);
      return new Response(result.summary, {
        headers: { "Content-Type": "text/plain;charset=UTF-8" },
      });
    }

    return new Response("Not Found", { status: 404 });
  },

  async scheduled(event, env, ctx) {
    console.log("⏰ 定时签到开始");
    try {
      const result = await runAllCheckins(env);
      console.log("📊 签到结果:", result.summary);
      await sendTelegram(env, result.summary);
    } catch (e) {
      console.error("❌ 定时任务失败:", e);
      await sendTelegram(env, `❌ 定时签到失败: ${e.message}`);
    }
  },
};

// ========== 核心签到逻辑 ==========
async function runAllCheckins(env) {
  const accounts = parseAccounts(env);
  if (typeof accounts === "string") {
    return { summary: accounts, logs: [accounts], results: [] };
  }

  const logs = [];
  const results = [];

  const concurrency = 3;
  for (let i = 0; i < accounts.length; i += concurrency) {
    const batch = accounts.slice(i, i + concurrency);
    const batchPromises = batch.map(async (acc) => {
      const res = await checkinSingleSite(acc, logs);
      results.push(res);
      return res;
    });
    await Promise.all(batchPromises);
  }

  const summary = results.map(r => `[${r.name}] ${r.message}`).join("\n");
  return { summary, logs, results };
}

async function checkinSingleSite(site, sharedLogs = null) {
  const log = (msg) => {
    console.log(`[${site.name}] ${msg}`);
    if (sharedLogs) sharedLogs.push(`[${site.name}] ${msg}`);
  };

  const baseUrl = site.url.replace(/\/$/, "");
  const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

  // ===== 支持自定义路径 =====
  const paths = {
    login: site.paths?.login || "/api/user/login",
    checkin: site.paths?.checkin || "/api/user/checkin",
    userInfo: site.paths?.userInfo || "/api/user/self"
  };

  const balanceField = site.balanceField || "data.money";
  const verifyByBalanceChange = site.verifyByBalanceChange !== false;

  const loginBody = {
    username: site.username,
    password: site.password,
  };

  try {
    const auth = { cookie: "", token: "" };

    log(`🔐 登录中 (${paths.login})`);
    const loginRes = await fetch(`${baseUrl}${paths.login}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "User-Agent": UA,
        "Accept": "application/json",
      },
      body: JSON.stringify(loginBody),
    });

    // 提取 Cookie
    const setCookie = loginRes.headers.get("set-cookie");
    if (setCookie) auth.cookie = setCookie;

    // 读取登录响应
    let loginData;
    try {
      loginData = await loginRes.json();
    } catch {
      const text = await loginRes.text();
      throw new Error(`登录响应非 JSON: ${text.substring(0, 100)}`);
    }

    if (!loginRes.ok) {
      const msg = loginData.message || loginData.error || `HTTP ${loginRes.status}`;
      throw new Error(`登录失败: ${msg}`);
    }

    // 提取 Token（兼容不同字段名）
    auth.token = loginData.data?.token || loginData.token || loginData.access_token || loginData.api_key || "";
    if (auth.token) {
      log(`✅ 登录成功，获取到 Token`);
    } else {
      log(`✅ 登录成功（无 Token，将使用 Cookie 认证）`);
    }

    // 获取签到前余额
    let balanceBefore = null;
    try {
      const beforeData = await authenticatedFetch(`${baseUrl}${paths.userInfo}`, auth, UA);
      balanceBefore = getValueByPath(beforeData, balanceField);
      log(`💰 签到前余额: ${balanceBefore ?? "未知"}`);
    } catch (e) {
      log(`⚠️ 获取签到前余额失败: ${e.message}`);
    }

    // 执行签到
    log(`📝 签到中 (${paths.checkin})`);
    const checkinRes = await fetch(`${baseUrl}${paths.checkin}`, {
      method: "POST",
      headers: buildHeaders(auth, UA),
    });

    let checkinData;
    try {
      checkinData = await checkinRes.json();
    } catch {
      const text = await checkinRes.text();
      throw new Error(`签到响应非 JSON: ${text.substring(0, 100)}`);
    }

    if (!checkinRes.ok) {
      const msg = checkinData.message || checkinData.error || `HTTP ${checkinRes.status}`;
      throw new Error(`签到请求失败: ${msg}`);
    }

    const checkinMsg = checkinData.message || (checkinData.success ? "签到成功" : "签到失败");
    let checkinSuccess = checkinData.success === true;
    const reward = checkinData.data?.reward || checkinData.reward || 0;

    // 获取签到后余额
    let balanceAfter = null;
    try {
      const afterData = await authenticatedFetch(`${baseUrl}${paths.userInfo}`, auth, UA);
      balanceAfter = getValueByPath(afterData, balanceField);
      log(`💰 签到后余额: ${balanceAfter ?? "未知"}`);
    } catch (e) {
      log(`⚠️ 获取签到后余额失败: ${e.message}`);
    }

    // 余额变化验证
    if (verifyByBalanceChange && balanceBefore !== null && balanceAfter !== null) {
      if (balanceAfter > balanceBefore) {
        const gain = (balanceAfter - balanceBefore).toFixed(4);
        log(`📈 余额增加 ${gain}，确认签到成功`);
        checkinSuccess = true;
      } else if (balanceAfter === balanceBefore) {
        log(`⚠️ 余额未变化，可能今日已签到`);
        checkinSuccess = checkinData.success || false;
      }
    }

    let finalMsg = checkinSuccess ? "✅ " : "❌ ";
    finalMsg += checkinMsg;
    if (reward > 0) finalMsg += ` | 获得 ${reward}`;
    finalMsg += ` | 余额: ${balanceAfter ?? "未知"}`;

    log(finalMsg);
    return {
      name: site.name || site.url,
      success: checkinSuccess,
      message: finalMsg,
    };
  } catch (error) {
    log(`❌ ${error.message}`);
    return { name: site.name || site.url, success: false, message: error.message };
  }
}

// 辅助函数：构建请求头（优先 Token，无则 Cookie）
function buildHeaders(auth, ua) {
  const headers = {
    "User-Agent": ua,
    "Accept": "application/json",
  };
  if (auth.token) {
    headers["Authorization"] = `Bearer ${auth.token}`;
  } else if (auth.cookie) {
    headers["Cookie"] = auth.cookie;
  }
  return headers;
}

// 辅助函数：发送带认证的 GET 请求
async function authenticatedFetch(url, auth, ua) {
  const res = await fetch(url, {
    headers: buildHeaders(auth, ua),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`请求失败 ${res.status}: ${text.substring(0, 100)}`);
  }
  return res.json();
}

function getValueByPath(obj, path) {
  return path.split('.').reduce((o, k) => (o || {})[k], obj);
}

function parseAccounts(env) {
  try {
    return JSON.parse(env.ACCOUNTS_JSON);
  } catch {
    return "错误: ACCOUNTS_JSON 格式不正确";
  }
}

async function sendTelegram(env, message) {
  const token = env.TGTOKEN;
  const chatId = env.TGID;
  if (!chatId) return;

  const text = `🤖 NewAPI签到结果\n${new Date().toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" })}\n\n${message}`;
  const encoded = encodeURIComponent(text);

  let apiUrl;
  if (token) {
    apiUrl = `https://api.telegram.org/bot${token}/sendMessage?chat_id=${chatId}&parse_mode=HTML&text=${encoded}`;
  } else {
    // 备用代理
    apiUrl = `https://api.tg.090227.xyz/sendMessage?chat_id=${chatId}&parse_mode=HTML&text=${encoded}`;
  }

  try {
    await fetch(apiUrl);
  } catch (e) {
    console.error("TG推送失败:", e);
  }
}

// ========== API 路由处理 ==========
async function handleApiRequest(request, env, pathname) {
  if (pathname !== "/api/login" && !(await verifyAuth(request, env))) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }

  try {
    switch (pathname) {
      case "/api/login":
        if (await verifyAuth(request, env)) {
          return Response.json({ success: true });
        }
        return new Response(JSON.stringify({ error: "Invalid password" }), { status: 401 });

      case "/api/sites": {
        const accounts = parseAccounts(env);
        if (typeof accounts === "string") {
          return Response.json({ error: accounts }, { status: 500 });
        }
        const safe = accounts.map(s => ({
          name: s.name || s.url,
          url: s.url,
          username: maskEmail(s.username),
        }));
        return Response.json(safe);
      }

      case "/api/checkin/all": {
        if (request.method !== "POST") return methodNotAllowed();
        const result = await runAllCheckins(env);
        if (env.TGID) await sendTelegram(env, result.summary);
        return Response.json(result);
      }

      case "/api/checkin/single": {
        if (request.method !== "POST") return methodNotAllowed();
        const { index } = await request.json();
        const accounts = parseAccounts(env);
        if (typeof accounts === "string") {
          return Response.json({ error: accounts }, { status: 500 });
        }
        if (!accounts[index]) {
          return Response.json({ error: "站点不存在" }, { status: 400 });
        }
        const logs = [];
        const result = await checkinSingleSite(accounts[index], logs);
        const summary = `[${result.name}] ${result.message}`;
        if (env.TGID) await sendTelegram(env, summary);
        return Response.json({ result, logs, summary });
      }

      case "/api/test_tg": {
        if (request.method !== "POST") return methodNotAllowed();
        if (!env.TGID) {
          return Response.json({ success: false, message: "未配置 TGID" });
        }
        try {
          await sendTelegram(env, "🔔 NewAPI签到助手：测试消息成功！");
          return Response.json({ success: true, message: "测试消息已发送" });
        } catch (e) {
          return Response.json({ success: false, message: e.message });
        }
      }

      default:
        return new Response("API Not Found", { status: 404 });
    }
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
}

async function verifyAuth(request, env) {
  const authHeader = request.headers.get("Authorization");
  if (!authHeader || !authHeader.startsWith("Bearer ")) return false;

  const clientHash = authHeader.split(" ")[1];
  const url = new URL(request.url);
  const hostname = url.hostname;
  const ua = request.headers.get("User-Agent") || "";
  const password = env.PANEL_PASSWORD || "";

  const rawString = hostname + password + ua;
  const encoder = new TextEncoder();
  const data = encoder.encode(rawString);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  const serverHash = hashArray.map(b => b.toString(16).padStart(2, "0")).join("");

  return clientHash === serverHash;
}

function methodNotAllowed() {
  return new Response("Method Not Allowed", { status: 405 });
}

function maskEmail(email) {
  if (!email || !email.includes("@")) return email;
  const [local, domain] = email.split("@");
  if (local.length <= 2) return "*".repeat(local.length) + "@" + domain;
  return local[0] + "*".repeat(local.length - 2) + local[local.length - 1] + "@" + domain;
}

// ========== HTML 模板 ==========
function getHtmlTemplate() {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>NewAPI 多账号签到</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: system-ui, -apple-system, sans-serif; background: #0b1120; color: #e2e8f0; min-height: 100vh; display: flex; flex-direction: column; }
    .glass { background: rgba(30, 41, 59, 0.7); backdrop-filter: blur(12px); border: 1px solid rgba(255,255,255,0.08); border-radius: 16px; }
    .hidden { display: none !important; }
    button { background: #3b82f6; color: white; border: none; padding: 10px 18px; border-radius: 8px; font-weight: 500; cursor: pointer; transition: 0.2s; }
    button:hover { background: #2563eb; }
    button.secondary { background: rgba(255,255,255,0.1); }
    button.secondary:hover { background: rgba(255,255,255,0.2); }
    button:disabled { opacity: 0.6; cursor: not-allowed; }
    input { width: 100%; padding: 12px 16px; background: #1e293b; border: 1px solid #334155; color: white; border-radius: 8px; }
    .container { max-width: 1200px; margin: 0 auto; padding: 24px; width: 100%; }
    .login-box { max-width: 400px; margin: 80px auto; padding: 40px; text-align: center; }
    .site-card { background: rgba(255,255,255,0.03); border-radius: 12px; padding: 16px; margin-bottom: 12px; display: flex; align-items: center; justify-content: space-between; }
    .log-panel { background: #0f172a; border-radius: 12px; padding: 16px; height: 400px; overflow-y: auto; font-family: monospace; font-size: 0.9rem; }
    .log-entry { margin-bottom: 6px; border-bottom: 1px solid #1e293b; padding-bottom: 6px; }
    .log-time { color: #64748b; margin-right: 12px; }
    .log-success { color: #10b981; }
    .log-error { color: #ef4444; }
    .log-info { color: #60a5fa; }
  </style>
</head>
<body>
  <div id="loginView" class="container">
    <div class="glass login-box">
      <h2 style="margin-bottom: 20px;">🔐 NewAPI 面板登录</h2>
      <form id="loginForm">
        <input type="password" id="passwordInput" placeholder="面板密码" autofocus>
        <button type="submit" style="margin-top: 16px; width: 100%;">登录</button>
      </form>
      <div id="loginError" style="color: #ef4444; margin-top: 12px;"></div>
    </div>
  </div>

  <div id="appView" class="hidden">
    <div class="container">
      <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 24px;">
        <h1>🌐 NewAPI 多账号签到</h1>
        <button id="logoutBtn" class="secondary">退出</button>
      </div>
      <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 24px;">
        <div>
          <div class="glass" style="padding: 20px;">
            <div style="display: flex; justify-content: space-between; margin-bottom: 16px;">
              <h3>📋 账号列表</h3>
              <div>
                <button id="checkinAllBtn" class="secondary" style="margin-right: 8px;">▶ 全部签到</button>
                <button id="refreshSitesBtn" class="secondary">🔄 刷新</button>
              </div>
            </div>
            <div id="sitesList"></div>
          </div>
          <div class="glass" style="padding: 20px; margin-top: 20px;">
            <h3 style="margin-bottom: 12px;">📡 Telegram</h3>
            <div id="tgStatus" style="margin-bottom: 16px;"></div>
            <button id="testTgBtn" class="secondary">📨 测试推送</button>
          </div>
        </div>
        <div>
          <div class="glass" style="padding: 20px;">
            <div style="display: flex; justify-content: space-between; margin-bottom: 12px;">
              <h3>📄 运行日志</h3>
              <button id="clearLogBtn" class="secondary">清空</button>
            </div>
            <div id="logPanel" class="log-panel">
              <div class="log-entry"><span class="log-time">[系统]</span> 控制台已就绪</div>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
  <script>
    const AUTH_KEY = 'newapi_panel_auth';
    let token = localStorage.getItem(AUTH_KEY);
    const loginView = document.getElementById('loginView');
    const appView = document.getElementById('appView');
    const loginForm = document.getElementById('loginForm');
    const passwordInput = document.getElementById('passwordInput');
    const loginError = document.getElementById('loginError');
    const sitesList = document.getElementById('sitesList');
    const logPanel = document.getElementById('logPanel');

    function log(message, type = 'info') {
      const entry = document.createElement('div');
      entry.className = 'log-entry';
      const time = new Date().toLocaleTimeString('zh-CN', { hour12: false });
      entry.innerHTML = \`<span class="log-time">[\${time}]</span><span class="log-\${type}">\${message}</span>\`;
      logPanel.appendChild(entry);
      logPanel.scrollTop = logPanel.scrollHeight;
    }

    async function generateHash(password) {
      const hostname = window.location.hostname;
      const ua = navigator.userAgent;
      const raw = hostname + password + ua;
      const encoder = new TextEncoder();
      const data = encoder.encode(raw);
      const hashBuffer = await crypto.subtle.digest('SHA-256', data);
      const hashArray = Array.from(new Uint8Array(hashBuffer));
      return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
    }

    async function api(endpoint, options = {}) {
      if (!token) throw new Error('未登录');
      const res = await fetch('/api' + endpoint, {
        ...options,
        headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json', ...options.headers }
      });
      if (res.status === 401) { logout(); throw new Error('会话过期'); }
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || '请求失败');
      return data;
    }

    loginForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      try {
        const hash = await generateHash(passwordInput.value);
        const res = await fetch('/api/login', { method: 'POST', headers: { 'Authorization': 'Bearer ' + hash } });
        if (res.ok) {
          token = hash;
          localStorage.setItem(AUTH_KEY, hash);
          showApp();
        } else {
          loginError.textContent = '密码错误';
        }
      } catch (err) { loginError.textContent = err.message; }
    });

    function logout() {
      localStorage.removeItem(AUTH_KEY);
      token = null;
      loginView.classList.remove('hidden');
      appView.classList.add('hidden');
    }

    async function showApp() {
      loginView.classList.add('hidden');
      appView.classList.remove('hidden');
      await loadSites();
      await loadTgStatus();
      log('✅ 登录成功', 'success');
    }

    async function loadSites() {
      try {
        const sites = await api('/sites');
        sitesList.innerHTML = sites.map((site, idx) => \`
          <div class="site-card">
            <div><strong>\${site.name}</strong><br><span style="font-size:0.85rem;color:#94a3b8;">\${site.url}</span><br><span>\${site.username}</span></div>
            <button onclick="checkinSingle(\${idx})" class="secondary" style="width:auto;">签到</button>
          </div>
        \`).join('');
        log(\`加载 \${sites.length} 个账号\`, 'info');
      } catch (e) { log('加载失败: ' + e.message, 'error'); }
    }

    window.checkinSingle = async function(index) {
      log(\`开始签到账号 #\${index}\`, 'info');
      try {
        const res = await api('/checkin/single', { method: 'POST', body: JSON.stringify({ index }) });
        res.logs.forEach(l => log(l, 'info'));
        log(res.summary, res.result.success ? 'success' : 'error');
      } catch (e) { log('失败: ' + e.message, 'error'); }
    };

    document.getElementById('checkinAllBtn').addEventListener('click', async () => {
      log('===== 批量签到开始 =====', 'info');
      try {
        const res = await api('/checkin/all', { method: 'POST' });
        res.logs.forEach(l => log(l, 'info'));
        log(res.summary, 'success');
      } catch (e) { log('失败: ' + e.message, 'error'); }
    });

    document.getElementById('refreshSitesBtn').addEventListener('click', loadSites);
    document.getElementById('clearLogBtn').addEventListener('click', () => logPanel.innerHTML = '');
    document.getElementById('logoutBtn').addEventListener('click', logout);

    async function loadTgStatus() {
      try {
        await api('/test_tg', { method: 'POST' });
        document.getElementById('tgStatus').innerHTML = '<span style="color:#10b981;">● 已配置</span>';
      } catch { document.getElementById('tgStatus').innerHTML = '<span style="color:#ef4444;">● 未配置</span>'; }
    }

    document.getElementById('testTgBtn').addEventListener('click', async () => {
      log('发送 TG 测试...', 'info');
      try {
        const res = await api('/test_tg', { method: 'POST' });
        log(res.message, res.success ? 'success' : 'error');
      } catch (e) { log('失败: ' + e.message, 'error'); }
    });

    if (token) {
      (async () => {
        try { await api('/sites'); showApp(); } catch { logout(); }
      })();
    }
  </script>
</body>
</html>`;
}