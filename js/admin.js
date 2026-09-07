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

  // ---- 本部(全店舗横断)管理者モード ----
  // 本部管理者としてログインした場合だけ、店舗選択プルダウンが現れて見る/操作する店舗を選べる。
  // hqSelectedStore が空文字のときは「(全店舗)」(一覧・統計は合算表示、設定タブは編集不可)を意味する
  let hqSelectedStore = '';

  // 現在の画面状態に応じて、adminList/getConfig/adminUpdateConfig/adminChangePassword に
  // 追加で渡すstoreパラメータを組み立てる(通常ログイン時はAPI側の既定値に任せるので何も足さない)
  function storeOverrideParams_() {
    return Api.isHqMode() ? { store: hqSelectedStore } : {};
  }

  function isLoggedIn() {
    return !!Api.getToken();
  }

  function showLogin() {
    Api.setToken('');
    Api.setHqMode(false);
    loginScreen.classList.add('active');
    adminScreen.classList.remove('active');
  }

  function showAdmin() {
    loginScreen.classList.remove('active');
    adminScreen.classList.add('active');
    setupHqUi_();
    refreshAll();
  }

  // 本部ログインかどうかで、店舗選択プルダウン・本部パスワード変更欄の表示/非表示を切り替える
  function setupHqUi_() {
    const wrap = document.getElementById('hq-store-select-wrap');
    const select = document.getElementById('hq-store-select');
    const label = document.getElementById('admin-store-label');
    const hqPasswordSection = document.getElementById('hq-password-section');
    const passwordHint = document.getElementById('password-form-hint');

    if (Api.isHqMode()) {
      wrap.hidden = false;
      hqPasswordSection.hidden = false;
      passwordHint.hidden = false;

      const stores = Api.getHqStores();
      let urlStore = '';
      try { urlStore = new URLSearchParams(location.search).get('store') || ''; } catch (e) { /* 無視 */ }
      const initial = stores.includes(urlStore) ? urlStore : '';

      select.innerHTML = '<option value="">(全店舗)</option>' +
        stores.map((s) => `<option value="${escapeHtml(s)}">${escapeHtml(s)}</option>`).join('');
      select.value = initial;
      hqSelectedStore = initial;
      label.textContent = hqSelectedStore ? ('店舗: ' + hqSelectedStore) : '本部管理者としてログイン中(全店舗)';
      updateHqDeleteButton_();
    } else {
      wrap.hidden = true;
      hqPasswordSection.hidden = true;
      passwordHint.hidden = true;
      hqSelectedStore = '';
      label.textContent = '店舗: ' + Api.getStore();
    }
  }

  document.getElementById('hq-store-select').addEventListener('change', (e) => {
    hqSelectedStore = e.target.value;
    document.getElementById('admin-store-label').textContent =
      hqSelectedStore ? ('店舗: ' + hqSelectedStore) : '本部管理者としてログイン中(全店舗)';
    couponCache = []; // 店舗を切り替えたら古いキャッシュを使い回さない
    updateHqDeleteButton_();
    reloadActiveTab_();
  });

  // 「(全店舗)」以外の特定の店舗を選んでいるときだけ削除ボタンを出す
  function updateHqDeleteButton_() {
    document.getElementById('btn-hq-delete-store').hidden = !hqSelectedStore;
  }

  document.getElementById('btn-hq-delete-store').addEventListener('click', async () => {
    const store = hqSelectedStore;
    if (!store) return;
    if (!confirm(`店舗「${store}」の設定・パスワードを削除しますか?\n(発行済みのクーポンのデータ自体は消えません。この店舗を再度使うと初期設定で作り直されます)`)) return;
    try {
      await Api.post('hqDeleteStore', { store });
    } catch (err) {
      alert('削除に失敗しました: ' + err.message);
      return;
    }
    // 店舗一覧を再取得する専用のAPIは無いため、その場でプルダウンの選択肢からも取り除いておく
    // (最新の一覧が必要な場合は、一度ログアウトして本部管理者としてログインし直せば取得し直される)
    hqSelectedStore = '';
    const stores = Api.getHqStores().filter((s) => s !== store);
    Api.setHqMode(true, stores);
    couponCache = [];
    setupHqUi_();
    reloadActiveTab_();
    alert(`店舗「${store}」の設定を削除しました`);
  });

  function reloadActiveTab_() {
    const activeBtn = document.querySelector('.tab-btn.active');
    const tab = activeBtn ? activeBtn.dataset.tab : 'list';
    if (tab === 'list') loadList();
    if (tab === 'stats') loadStats();
    if (tab === 'settings') loadSettingsForm();
  }

  document.getElementById('btn-login').addEventListener('click', tryLogin);
  loginPassword.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') tryLogin();
  });

  async function tryLogin() {
    loginError.hidden = true;
    const asHq = document.getElementById('login-as-hq').checked;
    try {
      if (asHq) {
        const result = await Api.post('hqLogin', { password: loginPassword.value });
        Api.setToken(result.token);
        Api.setHqMode(true, result.stores);
      } else {
        const result = await Api.post('adminLogin', { password: loginPassword.value });
        Api.setToken(result.token);
        Api.setHqMode(false);
      }
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
      const { coupons } = await Api.get('adminList', { search, ...storeOverrideParams_() });
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

    // 本部管理者モードのときだけ「店舗」列を出す(通常ログインでは今まで通り出さない)
    const showStore = Api.isHqMode();
    document.querySelector('#coupon-table .col-store').hidden = !showStore;
    const colCount = showStore ? 10 : 9;

    tbody.innerHTML = '';
    if (list.length === 0) {
      tbody.innerHTML = `<tr><td colspan="${colCount}" class="empty-row">該当するクーポンがありません</td></tr>`;
      return;
    }

    list.forEach((c) => {
      const tr = document.createElement('tr');
      const statusText = isUsed(c) ? `使用済み<br><span class="status-sub">${formatDateTime(c.usedAt)}</span>` : '未使用';
      const actionCell = isUsed(c)
        ? ''
        : `<button class="btn btn-secondary btn-small btn-mark-used" data-code="${escapeHtml(c.code)}">使用済みにする</button>`;
      tr.innerHTML = `
        ${showStore ? `<td>${escapeHtml(c.store || '')}</td>` : ''}
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
    const showStore = Api.isHqMode();
    const header = [
      ...(showStore ? ['店舗'] : []),
      'コード', '氏名', '得点', '等', '当選景品', '発行日時', '有効期限', '使用状況', '使用日時',
    ];
    const rows = couponCache.map((c) => [
      ...(showStore ? [c.store || ''] : []),
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
        const { coupons } = await Api.get('adminList', { search: '', ...storeOverrideParams_() });
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

  // ---- ゲームURL(ヘッダー下の常時表示バー。admin.htmlと同じ場所に公開されている前提でindex.htmlのURLを組み立てる) ----
  // 複数店舗対応: 管理画面を ?store=店舗名 付きで開いている場合、ゲームURL(QRコード用)にも
  // 同じstoreを引き継ぐ(店舗名を付けずに開いた今まで通りのURLでは、今まで通り何も付かない)
  function buildGameUrl_() {
    const current = new URL(location.href);
    const store = current.searchParams.get('store');
    let base = current.origin + current.pathname.replace(/admin\.html$/, '');
    if (store) base += '?store=' + encodeURIComponent(store);
    return base;
  }
  const gameUrl = buildGameUrl_();
  document.getElementById('game-url-text').textContent = gameUrl;

  const btnCopyGameUrl = document.getElementById('btn-copy-game-url');
  btnCopyGameUrl.addEventListener('click', () => {
    copyText_(gameUrl).then((ok) => {
      const original = btnCopyGameUrl.textContent;
      btnCopyGameUrl.textContent = ok ? 'コピーしました✓' : 'コピーできませんでした';
      btnCopyGameUrl.classList.toggle('copied', ok);
      setTimeout(() => {
        btnCopyGameUrl.textContent = original;
        btnCopyGameUrl.classList.remove('copied');
      }, 1800);
    });
  });

  // クリップボードAPIが使えない/権限が無い端末向けに、選択+execCommandのフォールバックを用意する
  function copyText_(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(text).then(() => true).catch(() => copyTextFallback_(text));
    }
    return Promise.resolve(copyTextFallback_(text));
  }

  function copyTextFallback_(text) {
    try {
      const textarea = document.createElement('textarea');
      textarea.value = text;
      textarea.style.position = 'fixed';
      textarea.style.opacity = '0';
      document.body.appendChild(textarea);
      textarea.focus();
      textarea.select();
      const ok = document.execCommand('copy');
      document.body.removeChild(textarea);
      return ok;
    } catch (e) {
      return false;
    }
  }

  // ---- QRコード ----
  document.getElementById('qrcode-url').value = gameUrl; // 毎回貼り直さなくていいよう、ゲームURLを初期値として入れておく
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
  const TIER_LABELS_5 = ['特等', '1等', '2等', '3等', '4等'];
  const TIER_INDEXES = [0, 1, 2, 3, 4];

  // 連打・多重送信を防ぐため、保存中はボタンを無効化して「保存中...」を表示する
  async function withSavingState_(button, savingText, task) {
    const original = button.textContent;
    button.disabled = true;
    button.textContent = savingText;
    try {
      await task();
    } finally {
      button.disabled = false;
      button.textContent = original;
    }
  }

  // 景品名のプルダウンに、一覧(js/prize-catalog.js)の選択肢を入れておく(誤字防止・入力の手間を無くすため)
  // 4等だけは「使用しない」を選べるよう、先頭に空欄の選択肢を追加する
  TIER_INDEXES.forEach((i) => {
    const select = tiersForm.elements['tier' + i + 'Name'];
    const blankOption = i === 4 ? '<option value="">(4等を使用しない)</option>' : '';
    select.innerHTML = blankOption + PrizeCatalog.PRIZE_CATALOG.map(
      (p) => `<option value="${escapeHtml(p.name)}">${escapeHtml(p.name)}</option>`
    ).join('');
  });

  // 重みのプルダウンは0〜100の整数のみ(誤入力防止)
  TIER_INDEXES.forEach((i) => {
    const select = tiersForm.elements['tier' + i + 'Weight'];
    let options = '';
    for (let w = 0; w <= 100; w++) options += `<option value="${w}">${w}</option>`;
    select.innerHTML = options;
  });

  // 4等の景品名が「使用しない」(空欄)のときは、重みを0で固定して操作できないようにする
  function syncTier4WeightState_() {
    const nameSelect = tiersForm.elements['tier4Name'];
    const weightSelect = tiersForm.elements['tier4Weight'];
    const active = !!nameSelect.value;
    weightSelect.disabled = !active;
    if (!active) weightSelect.value = '0';
  }
  tiersForm.elements['tier4Name'].addEventListener('change', () => {
    syncTier4WeightState_();
    renderProbabilities_();
  });

  // ---- 当選確率パネル(参考表示。GASのdrawTier_と同じ計算式で、スコア100点時の確率を算出する) ----
  function calcProbabilities_(tiersList, score) {
    const active = tiersList
      .map((t, idx) => ({ ...t, idx }))
      .filter((t) => (Number(t.weight) || 0) > 0);
    if (!active.length) return [];
    const effective = active.map((t, i) => {
      const rarityRank = active.length - 1 - i; // 先頭(レア)ほど大きい値。GAS側drawTier_と同じ考え方
      return Math.max(Number(t.weight) || 0, 0) + rarityRank * (score / 50);
    });
    const total = effective.reduce((a, b) => a + b, 0);
    return active.map((t, i) => ({
      idx: t.idx,
      percent: total > 0 ? (effective[i] / total) * 100 : 0,
    }));
  }

  function renderProbabilities_() {
    const tiersNow = TIER_INDEXES.map((i) => ({
      label: TIER_LABELS_5[i],
      name: tiersForm.elements['tier' + i + 'Name'].value || TIER_LABELS_5[i],
      weight: Number(tiersForm.elements['tier' + i + 'Weight'].value) || 0,
    }));
    const probs = calcProbabilities_(tiersNow, 100);
    const percentByIdx = {};
    probs.forEach((p) => { percentByIdx[p.idx] = p.percent; });

    const list = document.getElementById('probability-list');
    list.innerHTML = tiersNow.map((t, i) => {
      const active = t.weight > 0;
      if (!active) {
        return `
          <div class="probability-row is-inactive">
            <div class="probability-row-head"><span>${escapeHtml(t.label)}</span><span>対象外(重み0)</span></div>
          </div>
        `;
      }
      const pct = percentByIdx[i] || 0;
      return `
        <div class="probability-row">
          <div class="probability-row-head"><span>${escapeHtml(t.label)}</span><span>${pct.toFixed(1)}%</span></div>
          <div class="probability-row-name">${escapeHtml(t.name)}</div>
          <div class="probability-bar"><div class="probability-bar-fill" style="width:${Math.min(pct, 100)}%"></div></div>
        </div>
      `;
    }).join('');
  }

  tiersForm.addEventListener('change', renderProbabilities_);

  async function loadSettingsForm() {
    const hqMessage = document.getElementById('hq-select-store-message');
    const content = document.getElementById('store-settings-content');
    // 本部管理者モードで「(全店舗)」のままだと、どの店舗の設定を出せばよいか決められないため、
    // 案内メッセージだけ出してフォームは表示しない
    if (Api.isHqMode() && !hqSelectedStore) {
      hqMessage.hidden = false;
      content.hidden = true;
      return;
    }
    hqMessage.hidden = true;
    content.hidden = false;
    try {
      const cfg = await Api.get('getConfig', storeOverrideParams_());
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
        // 4等が未設定(名前がラベルそのまま=既定値)のときは、プルダウンを空欄(使用しない)にする
        if (nameField) nameField.value = (i === 4 && t.name === TIER_LABELS_5[4]) ? '' : t.name;
        if (weightField) weightField.value = t.weight;
      });
      syncTier4WeightState_();
      renderProbabilities_();
    } catch (err) {
      handleAuthError_(err);
    }
  }

  settingsForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const button = settingsForm.querySelector('button[type="submit"]');
    withSavingState_(button, '保存中...しばらくお待ちください', async () => {
      try {
        await Api.post('adminUpdateConfig', {
          gameDuration: Number(settingsForm.gameDuration.value) || 30,
          pointsPerPizza: Number(settingsForm.pointsPerPizza.value) || 20,
          couponScoreThreshold: Number(settingsForm.couponScoreThreshold.value) || 100,
          couponValidMonths: Number(settingsForm.couponValidMonths.value) || 3,
          storeName: settingsForm.storeName.value.trim(),
          maxCouponsTotal: Math.max(Number(settingsForm.maxCouponsTotal.value) || 0, 0),
          maxCouponsPerDay: Math.max(Number(settingsForm.maxCouponsPerDay.value) || 0, 0),
          ...storeOverrideParams_(),
        });
        alert('設定を保存しました');
      } catch (err) {
        alert('保存に失敗しました: ' + err.message);
      }
    });
  });

  tiersForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const button = tiersForm.querySelector('button[type="submit"]');
    withSavingState_(button, '保存中...しばらくお待ちください', async () => {
      const tiers = TIER_INDEXES.map((i) => ({
        name: tiersForm.elements['tier' + i + 'Name'].value.trim() || TIER_LABELS_5[i],
        weight: Math.max(Number(tiersForm.elements['tier' + i + 'Weight'].value) || 0, 0),
      }));
      try {
        await Api.post('adminUpdateConfig', { tiers, ...storeOverrideParams_() });
        alert('景品設定を保存しました');
      } catch (err) {
        alert('保存に失敗しました: ' + err.message);
      }
    });
  });

  const passwordForm = document.getElementById('password-form');
  passwordForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const button = passwordForm.querySelector('button[type="submit"]');
    withSavingState_(button, '変更中...しばらくお待ちください', async () => {
      try {
        await Api.post('adminChangePassword', {
          currentPassword: passwordForm.currentPassword.value,
          newPassword: passwordForm.newPassword.value,
          ...storeOverrideParams_(),
        });
        passwordForm.reset();
        alert('パスワードを変更しました');
      } catch (err) {
        alert('変更に失敗しました: ' + err.message);
      }
    });
  });

  // 本部管理者パスワード自体の変更(各店舗のパスワードとは別。本部ログイン中のみ表示される)
  const hqPasswordForm = document.getElementById('hq-password-form');
  hqPasswordForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const button = hqPasswordForm.querySelector('button[type="submit"]');
    withSavingState_(button, '変更中...しばらくお待ちください', async () => {
      try {
        await Api.post('hqChangePassword', {
          currentPassword: hqPasswordForm.currentPassword.value,
          newPassword: hqPasswordForm.newPassword.value,
        });
        hqPasswordForm.reset();
        alert('本部パスワードを変更しました');
      } catch (err) {
        alert('変更に失敗しました: ' + err.message);
      }
    });
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
