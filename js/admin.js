// admin.js - 管理者画面ロジック(Google Apps Script連携)
(function () {
  const loginScreen = document.getElementById('screen-login');
  const adminScreen = document.getElementById('screen-admin');
  const loginPassword = document.getElementById('login-password');
  const loginError = document.getElementById('login-error');
  const configWarning = document.getElementById('config-warning');

  let couponCache = [];

  if (!Api.isConfigured()) {
    configWarning.hidden = false;
  }

  function isLoggedIn() {
    return !!Api.getToken();
  }

  function showLogin() {
    Api.setToken('');
    loginScreen.classList.add('active');
    adminScreen.classList.remove('active');
  }

  function showAdmin() {
    loginScreen.classList.remove('active');
    adminScreen.classList.add('active');
    refreshAll();
  }

  document.getElementById('btn-login').addEventListener('click', tryLogin);
  loginPassword.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') tryLogin();
  });

  async function tryLogin() {
    loginError.hidden = true;
    try {
      const result = await Api.post('adminLogin', { password: loginPassword.value });
      Api.setToken(result.token);
      loginPassword.value = '';
      showAdmin();
    } catch (err) {
      loginError.hidden = false;
      loginError.textContent = err.message;
    }
  }

  document.getElementById('btn-logout').addEventListener('click', showLogin);

  // タブ切り替え
  document.querySelectorAll('.tab-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tab-btn').forEach((b) => b.classList.remove('active'));
      document.querySelectorAll('.tab-panel').forEach((p) => p.classList.remove('active'));
      btn.classList.add('active');
      document.getElementById('tab-' + btn.dataset.tab).classList.add('active');
      if (btn.dataset.tab === 'list') loadList();
      if (btn.dataset.tab === 'stats') loadStats();
      if (btn.dataset.tab === 'settings') loadSettingsForm();
    });
  });

  // ---- クーポン一覧 ----
  const tbody = document.getElementById('coupon-tbody');
  const listLoading = document.getElementById('list-loading');
  let searchDebounce = null;
  document.getElementById('search-code').addEventListener('input', () => {
    clearTimeout(searchDebounce);
    searchDebounce = setTimeout(loadList, 300);
  });
  document.getElementById('filter-status').addEventListener('change', renderTable);
  document.getElementById('btn-refresh').addEventListener('click', loadList);
  document.getElementById('btn-export').addEventListener('click', exportCsv);

  async function loadList() {
    listLoading.hidden = false;
    const search = document.getElementById('search-code').value.trim();
    try {
      const { coupons } = await Api.get('adminList', { search });
      couponCache = coupons;
      renderTable();
    } catch (err) {
      handleAuthError_(err);
    } finally {
      listLoading.hidden = true;
    }
  }

  function isExpired(c) {
    return Date.now() > c.expiresAt;
  }

  function isUsed(c) {
    return !!c.usedAt;
  }

  function renderTable() {
    const filter = document.getElementById('filter-status').value;
    let list = couponCache;
    if (filter === 'expired') list = list.filter((c) => isExpired(c));
    if (filter === 'unused') list = list.filter((c) => !isUsed(c));
    if (filter === 'used') list = list.filter((c) => isUsed(c));

    tbody.innerHTML = '';
    if (list.length === 0) {
      tbody.innerHTML = '<tr><td colspan="9" class="empty-row">該当するクーポンがありません</td></tr>';
      return;
    }

    list.forEach((c) => {
      const tr = document.createElement('tr');
      const statusText = isUsed(c) ? `使用済み<br><span class="status-sub">${formatDateTime(c.usedAt)}</span>` : '未使用';
      const actionCell = isUsed(c)
        ? ''
        : `<button class="btn btn-secondary btn-small btn-mark-used" data-code="${escapeHtml(c.code)}">使用済みにする</button>`;
      tr.innerHTML = `
        <td>${escapeHtml(c.code)}</td>
        <td>${escapeHtml(c.name)}</td>
        <td>${c.score}</td>
        <td>${escapeHtml(c.tier)}</td>
        <td>${escapeHtml(c.prizeName)}</td>
        <td>${formatDateTime(c.issuedAt)}</td>
        <td>${formatDate(c.expiresAt)}</td>
        <td>${statusText}</td>
        <td>${actionCell}</td>
      `;
      tbody.appendChild(tr);
    });
  }

  tbody.addEventListener('click', (e) => {
    const btn = e.target.closest('.btn-mark-used');
    if (!btn) return;
    markUsedAdmin(btn.dataset.code);
  });

  async function markUsedAdmin(code) {
    if (!confirm(`クーポン「${code}」を使用済みにしますか?この操作は取り消せません。`)) return;
    try {
      await Api.post('markUsed', { code });
      await loadList();
    } catch (err) {
      alert('使用済みにできませんでした: ' + err.message);
    }
  }

  function exportCsv() {
    const header = ['コード', '氏名', '得点', '等', '当選景品', '発行日時', '有効期限', '使用状況', '使用日時'];
    const rows = couponCache.map((c) => [
      c.code,
      c.name,
      c.score,
      c.tier,
      c.prizeName,
      formatDateTime(c.issuedAt),
      formatDate(c.expiresAt),
      isUsed(c) ? '使用済み' : '未使用',
      isUsed(c) ? formatDateTime(c.usedAt) : '',
    ]);
    const csv = [header, ...rows].map((r) => r.map(csvEscape).join(',')).join('\r\n');
    const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `coupons_${Date.now()}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  function csvEscape(v) {
    const s = String(v == null ? '' : v);
    if (/[",\r\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
    return s;
  }

  // ---- 統計(一覧データから集計) ----
  function isSameDay(a, b) {
    const da = new Date(a);
    const db = new Date(b);
    return da.getFullYear() === db.getFullYear() && da.getMonth() === db.getMonth() && da.getDate() === db.getDate();
  }

  const DAY_RANGES = [
    { label: '1〜7日', from: 1, to: 7 },
    { label: '8〜14日', from: 8, to: 14 },
    { label: '15〜21日', from: 15, to: 21 },
    { label: '22〜28日', from: 22, to: 28 },
    { label: '29日〜末日', from: 29, to: 31 },
  ];

  async function loadStats() {
    if (!couponCache.length) {
      try {
        const { coupons } = await Api.get('adminList', { search: '' });
        couponCache = coupons;
      } catch (err) {
        handleAuthError_(err);
        return;
      }
    }
    renderStats();
    populateMonthSelect();
    renderMonthlyStats();
  }

  function renderStats() {
    const now = Date.now();
    const total = couponCache.length;
    const todayCount = couponCache.filter((c) => isSameDay(c.issuedAt, now)).length;

    const grid = document.getElementById('stats-grid');
    grid.innerHTML = `
      <div class="stat-card"><div class="stat-num">${total}</div><div class="stat-label">発行総数</div></div>
      <div class="stat-card"><div class="stat-num">${todayCount}</div><div class="stat-label">本日の発行数</div></div>
    `;
  }

  function monthKeyOf(ts) {
    const d = new Date(ts);
    return `${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, '0')}`;
  }

  function populateMonthSelect() {
    const select = document.getElementById('stats-month-select');
    const keys = Array.from(new Set(couponCache.map((c) => monthKeyOf(c.issuedAt))));
    const currentKey = monthKeyOf(Date.now());
    if (!keys.includes(currentKey)) keys.push(currentKey);
    keys.sort().reverse();

    const prevValue = select.value;
    select.innerHTML = keys.map((k) => `<option value="${k}">${k}</option>`).join('');
    select.value = keys.includes(prevValue) ? prevValue : currentKey;
  }

  document.getElementById('stats-month-select').addEventListener('change', renderMonthlyStats);

  function renderMonthlyStats() {
    const select = document.getElementById('stats-month-select');
    const monthKey = select.value;
    const tbody = document.getElementById('monthly-stats-tbody');
    if (!monthKey) {
      tbody.innerHTML = '<tr><td colspan="2" class="empty-row">データがありません</td></tr>';
      return;
    }

    const monthCoupons = couponCache.filter((c) => monthKeyOf(c.issuedAt) === monthKey);
    tbody.innerHTML = DAY_RANGES.map((range) => {
      const count = monthCoupons.filter((c) => {
        const day = new Date(c.issuedAt).getDate();
        return day >= range.from && day <= range.to;
      }).length;
      return `<tr><td>${range.label}</td><td>${count}</td></tr>`;
    }).join('');
  }

  // ---- QRコード ----
  document.getElementById('btn-generate-qr').addEventListener('click', () => {
    const url = document.getElementById('qrcode-url').value.trim();
    if (!url) return;
    const qrUrl = 'https://api.qrserver.com/v1/create-qr-code/?size=400x400&data=' + encodeURIComponent(url);
    document.getElementById('qrcode-image').src = qrUrl;
    document.getElementById('qrcode-download').href = qrUrl;
    document.getElementById('qrcode-result').hidden = false;
  });

  // ---- 設定 ----
  const settingsForm = document.getElementById('settings-form');
  const tiersForm = document.getElementById('tiers-form');

  async function loadSettingsForm() {
    try {
      const cfg = await Api.get('getConfig');
      settingsForm.gameDuration.value = cfg.gameDuration;
      settingsForm.pointsPerPizza.value = cfg.pointsPerPizza;
      settingsForm.couponScoreThreshold.value = cfg.couponScoreThreshold;
      settingsForm.couponValidMonths.value = cfg.couponValidMonths;
      settingsForm.storeName.value = cfg.storeName || '';
      settingsForm.maxCouponsTotal.value = cfg.maxCouponsTotal || 0;
      settingsForm.maxCouponsPerDay.value = cfg.maxCouponsPerDay || 0;

      const tiers = cfg.tiers || [];
      tiers.forEach((t, i) => {
        const nameField = tiersForm.elements['tier' + i + 'Name'];
        const weightField = tiersForm.elements['tier' + i + 'Weight'];
        if (nameField) nameField.value = t.name;
        if (weightField) weightField.value = t.weight;
      });
    } catch (err) {
      handleAuthError_(err);
    }
  }

  settingsForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await Api.post('adminUpdateConfig', {
        gameDuration: Number(settingsForm.gameDuration.value) || 30,
        pointsPerPizza: Number(settingsForm.pointsPerPizza.value) || 20,
        couponScoreThreshold: Number(settingsForm.couponScoreThreshold.value) || 100,
        couponValidMonths: Number(settingsForm.couponValidMonths.value) || 3,
        storeName: settingsForm.storeName.value.trim(),
        maxCouponsTotal: Math.max(Number(settingsForm.maxCouponsTotal.value) || 0, 0),
        maxCouponsPerDay: Math.max(Number(settingsForm.maxCouponsPerDay.value) || 0, 0),
      });
      alert('設定を保存しました');
    } catch (err) {
      alert('保存に失敗しました: ' + err.message);
    }
  });

  tiersForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const tierLabels = ['特等', '1等', '2等', '3等'];
    const tiers = [0, 1, 2, 3].map((i) => ({
      name: tiersForm.elements['tier' + i + 'Name'].value.trim() || tierLabels[i],
      weight: Math.max(Number(tiersForm.elements['tier' + i + 'Weight'].value) || 0, 0),
    }));
    try {
      await Api.post('adminUpdateConfig', { tiers });
      alert('景品設定を保存しました');
    } catch (err) {
      alert('保存に失敗しました: ' + err.message);
    }
  });

  const passwordForm = document.getElementById('password-form');
  passwordForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await Api.post('adminChangePassword', {
        currentPassword: passwordForm.currentPassword.value,
        newPassword: passwordForm.newPassword.value,
      });
      passwordForm.reset();
      alert('パスワードを変更しました');
    } catch (err) {
      alert('変更に失敗しました: ' + err.message);
    }
  });

  function handleAuthError_(err) {
    console.error(err);
    if (String(err.message).includes('認証')) {
      alert('セッションが切れました。再度ログインしてください。');
      showLogin();
    } else {
      alert('通信エラー: ' + err.message);
    }
  }

  function escapeHtml(s) {
    return String(s).replace(
      /[&<>"']/g,
      (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])
    );
  }

  function formatDate(ts) {
    const d = new Date(ts);
    return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`;
  }

  function formatDateTime(ts) {
    const d = new Date(ts);
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  function refreshAll() {
    loadList();
    loadSettingsForm();
  }

  if (isLoggedIn()) showAdmin();
  else showLogin();
})();
