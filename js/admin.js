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
      if (btn.dataset.tab === 'stats') {
        renderStats();
        renderMonthlyStats();
      }
      if (btn.dataset.tab === 'settings') loadSettingsForm();
    });
  });

  // ---- クーポン照会 ----
  const verifyInput = document.getElementById('verify-input');
  const verifyResult = document.getElementById('verify-result');

  document.getElementById('btn-verify').addEventListener('click', doVerify);
  verifyInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') doVerify();
  });

  async function doVerify() {
    const code = verifyInput.value.trim().toUpperCase();
    if (!code) return;
    verifyResult.hidden = false;
    verifyResult.className = 'verify-result';
    verifyResult.innerHTML = '<p>照会中...</p>';

    let coupon;
    try {
      const { coupons } = await Api.get('adminList', { search: code });
      coupon = coupons.find((c) => c.code === code);
    } catch (err) {
      handleAuthError_(err);
      return;
    }

    if (!coupon) {
      verifyResult.className = 'verify-result state-notfound';
      verifyResult.innerHTML = `<p>❌ コード「${escapeHtml(code)}」は見つかりませんでした。</p>`;
      return;
    }

    const expired = Date.now() > coupon.expiresAt && coupon.status !== '使用済み';

    if (coupon.status === '使用済み') {
      verifyResult.className = 'verify-result state-used';
      verifyResult.innerHTML = `
        <p>⚠️ このクーポンは使用済みです。</p>
        <p>氏名: ${escapeHtml(coupon.name)} / 利用タイミング: ${escapeHtml(coupon.useTiming)}</p>
        <p>使用日時: ${formatDateTime(coupon.usedAt)}</p>
        <button id="btn-unuse" class="btn btn-secondary">使用済みを取り消す</button>
      `;
      document.getElementById('btn-unuse').addEventListener('click', async () => {
        await Api.post('adminUnmarkUsed', { code: coupon.code });
        doVerify();
      });
    } else if (expired) {
      verifyResult.className = 'verify-result state-expired';
      verifyResult.innerHTML = `
        <p>⌛ このクーポンは有効期限切れです。</p>
        <p>氏名: ${escapeHtml(coupon.name)}</p>
        <p>有効期限: ${formatDate(coupon.expiresAt)}</p>
      `;
    } else {
      verifyResult.className = 'verify-result state-valid';
      verifyResult.innerHTML = `
        <p>✅ 有効なクーポンです。</p>
        <p>氏名: ${escapeHtml(coupon.name)} / 得点: ${coupon.score}点 / 利用タイミング: ${escapeHtml(coupon.useTiming)}</p>
        <p>有効期限: ${formatDate(coupon.expiresAt)}</p>
        <button id="btn-use" class="btn btn-primary">使用済みにする</button>
      `;
      document.getElementById('btn-use').addEventListener('click', async () => {
        await Api.post('adminMarkUsed', { code: coupon.code });
        doVerify();
      });
    }
  }

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

  function statusOf(c) {
    if (c.status === '使用済み') return 'used';
    if (Date.now() > c.expiresAt) return 'expired';
    return 'unused';
  }

  function statusLabel(s) {
    return { used: '使用済み', expired: '期限切れ', unused: '未使用' }[s];
  }

  function renderTable() {
    const filter = document.getElementById('filter-status').value;
    let list = couponCache;
    if (filter !== 'all') list = list.filter((c) => statusOf(c) === filter);

    tbody.innerHTML = '';
    if (list.length === 0) {
      tbody.innerHTML = '<tr><td colspan="8" class="empty-row">該当するクーポンがありません</td></tr>';
      return;
    }

    list.forEach((c) => {
      const s = statusOf(c);
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td>${escapeHtml(c.code)}</td>
        <td>${escapeHtml(c.name)}</td>
        <td>${c.score}</td>
        <td>${escapeHtml(c.useTiming)}</td>
        <td>${formatDateTime(c.issuedAt)}</td>
        <td>${formatDate(c.expiresAt)}</td>
        <td><span class="badge badge-${s}">${statusLabel(s)}</span></td>
        <td></td>
      `;
      const actionTd = tr.lastElementChild;
      if (s === 'unused') {
        const btn = document.createElement('button');
        btn.className = 'btn btn-small btn-primary';
        btn.textContent = '使用済みにする';
        btn.addEventListener('click', async () => {
          await Api.post('adminMarkUsed', { code: c.code });
          loadList();
        });
        actionTd.appendChild(btn);
      } else if (s === 'used') {
        const btn = document.createElement('button');
        btn.className = 'btn btn-small btn-secondary';
        btn.textContent = '取り消す';
        btn.addEventListener('click', async () => {
          await Api.post('adminUnmarkUsed', { code: c.code });
          loadList();
        });
        actionTd.appendChild(btn);
      }
      tbody.appendChild(tr);
    });
  }

  function exportCsv() {
    const header = ['コード', '氏名', '得点', '利用タイミング', '発行日時', '有効期限', '状態', '使用日時'];
    const rows = couponCache.map((c) => [
      c.code,
      c.name,
      c.score,
      c.useTiming,
      formatDateTime(c.issuedAt),
      formatDate(c.expiresAt),
      statusLabel(statusOf(c)),
      c.usedAt ? formatDateTime(c.usedAt) : '',
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
  function renderStats() {
    const list = couponCache;
    const now = Date.now();
    const stats = {
      total: list.length,
      used: list.filter((c) => c.status === '使用済み').length,
      unused: list.filter((c) => c.status !== '使用済み' && c.expiresAt >= now).length,
      expired: list.filter((c) => c.status !== '使用済み' && c.expiresAt < now).length,
    };
    stats.usageRate = stats.total ? Math.round((stats.used / stats.total) * 100) : 0;

    const grid = document.getElementById('stats-grid');
    grid.innerHTML = `
      <div class="stat-card"><div class="stat-num">${stats.total}</div><div class="stat-label">発行総数</div></div>
      <div class="stat-card"><div class="stat-num">${stats.used}</div><div class="stat-label">使用済み</div></div>
      <div class="stat-card"><div class="stat-num">${stats.unused}</div><div class="stat-label">未使用(有効)</div></div>
      <div class="stat-card"><div class="stat-num">${stats.expired}</div><div class="stat-label">期限切れ</div></div>
      <div class="stat-card"><div class="stat-num">${stats.usageRate}%</div><div class="stat-label">利用率</div></div>
    `;
  }

  function renderMonthlyStats() {
    const groups = {};
    couponCache.forEach((c) => {
      const d = new Date(c.issuedAt);
      const key = `${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, '0')}`;
      if (!groups[key]) groups[key] = { issued: 0, used: 0 };
      groups[key].issued += 1;
      if (c.status === '使用済み') groups[key].used += 1;
    });

    const tbody = document.getElementById('monthly-stats-tbody');
    const keys = Object.keys(groups).sort().reverse();
    tbody.innerHTML = '';
    if (keys.length === 0) {
      tbody.innerHTML = '<tr><td colspan="4" class="empty-row">データがありません</td></tr>';
      return;
    }
    keys.forEach((key) => {
      const g = groups[key];
      const rate = g.issued ? Math.round((g.used / g.issued) * 100) : 0;
      const tr = document.createElement('tr');
      tr.innerHTML = `<td>${key}</td><td>${g.issued}</td><td>${g.used}</td><td>${rate}%</td>`;
      tbody.appendChild(tr);
    });
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

  async function loadSettingsForm() {
    try {
      const cfg = await Api.get('getConfig');
      settingsForm.gameDuration.value = cfg.gameDuration;
      settingsForm.pointsPerPizza.value = cfg.pointsPerPizza;
      settingsForm.couponScoreThreshold.value = cfg.couponScoreThreshold;
      settingsForm.rewardTextToday.value = cfg.rewardTextToday;
      settingsForm.rewardTextNextTime.value = cfg.rewardTextNextTime;
      settingsForm.couponValidMonths.value = cfg.couponValidMonths;
      settingsForm.storeName.value = cfg.storeName || '';
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
        rewardTextToday: settingsForm.rewardTextToday.value.trim() || 'ジェラート無料券',
        rewardTextNextTime: settingsForm.rewardTextNextTime.value.trim() || '次回来店10%OFF券',
        couponValidMonths: Number(settingsForm.couponValidMonths.value) || 3,
        storeName: settingsForm.storeName.value.trim(),
      });
      alert('設定を保存しました');
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
