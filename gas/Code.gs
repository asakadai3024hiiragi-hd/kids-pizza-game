/**
 * Code.gs - ピザ職人チャレンジ バックエンド(Google Apps Script)
 *
 * このスクリプトをスプレッドシートに紐づけたApps Scriptプロジェクトとして貼り付け、
 * ウェブアプリとして公開してください。手順はプロジェクトルートの README.md を参照。
 *
 * スプレッドシートには "Coupons" という名前のシートを用意し、1行目に以下の見出しを入れてください。
 * 発行日時 | 保護者氏名 | クーポン番号 | スコア | 有効期限 | 等 | 当選景品 | 使用日時
 *
 * H列(使用日時)が無い既存シートでも、初回アクセス時に自動で見出しが追加されます(ensureSheetSchema_)。
 *
 * クーポンの利用確認は、お客様のゲーム端末に表示される「クーポン確認」画面をスタッフが目視で確認し、
 * 「使用済みにする」操作(ゲーム端末 or 管理画面のどちらからでも可)を行うことで一度きりの利用に制限します。
 */

const SHEET_NAME = 'Coupons';
const TOKEN_TTL_SECONDS = 60 * 60 * 2; // 管理者トークンの有効期限(2時間)
const TIER_LABELS = ['特等', '1等', '2等', '3等']; // 取得確率が低い順(特等が最もレア)

// ---- 既定の設定値(初回アクセス時にScript Propertiesへ書き込まれる) ----
const DEFAULT_SETTINGS = {
  gameDuration: 30,           // ゲーム時間(秒)
  pointsPerPizza: 20,         // ピザ1個完成あたりの得点
  couponScoreThreshold: 100,  // クーポン取得に必要な得点
  // ガチャの景品(特等/1等/2等/3等の4段階固定)。weight=0にするとその等は抽選から除外される
  tiers: [
    { label: '特等', name: '特製ピザ無料券', weight: 1 },
    { label: '1等', name: 'デザートプレート無料券', weight: 4 },
    { label: '2等', name: 'ドリンク無料券', weight: 15 },
    { label: '3等', name: 'ジェラート無料券', weight: 30 },
  ],
  couponValidMonths: 3,       // クーポン有効期間(発行日から何ヶ月か)
  storeName: '',              // 発行店舗名(クーポン画面に表示。空欄なら非表示)
  maxCouponsTotal: 0,         // クーポン発行の累計上限(0=無制限)
  maxCouponsPerDay: 0,        // クーポン発行の1日あたり上限(0=無制限)
  adminPasswordHash: hashPassword_('admin123'), // 初期パスワード。必ず管理画面から変更してください
};

/** ウェブアプリのエントリポイント(GET) */
function doGet(e) {
  return handleRequest_(e.parameter, e.parameter.action);
}

/** ウェブアプリのエントリポイント(POST) */
function doPost(e) {
  let payload = {};
  try {
    payload = JSON.parse(e.postData.contents);
  } catch (err) {
    return jsonResponse_({ ok: false, error: 'リクエストの形式が不正です' });
  }
  return handleRequest_(payload, payload.action);
}

const IDEM_CACHE_TTL_SECONDS = 600; // 冪等キーのキャッシュ保持時間(10分。再試行の待ち時間より十分長く取る)
const IDEM_WAIT_ATTEMPTS = 8; // 処理中の別リクエストの完了を待つ回数
const IDEM_WAIT_INTERVAL_MS = 500;

// ---- レート制限(認証の無いactionへの連打・自動操作対策) ----
// Apps ScriptのWebアプリは呼び出し元のIPアドレスを取得できないため、呼び出し元ごとではなく
// 「action全体で1分間に何回まで」という形で制限する(小規模な1店舗運用なら通常利用には十分な余裕を持たせてある)
const RATE_LIMITS = {
  issueCoupon: { max: 20, windowSeconds: 60 },
  checkCoupons: { max: 60, windowSeconds: 60 },
  markUsed: { max: 30, windowSeconds: 60 },
  adminLogin: { max: 10, windowSeconds: 60 }, // 管理者パスワードの総当たり対策
  searchByName: { max: 20, windowSeconds: 60 },
};

function checkRateLimit_(action) {
  const limit = RATE_LIMITS[action];
  if (!limit) return;
  const cache = CacheService.getScriptCache();
  const windowIndex = Math.floor(Date.now() / (limit.windowSeconds * 1000));
  const key = 'rl_' + action + '_' + windowIndex;
  const current = Number(cache.get(key) || 0);
  if (current >= limit.max) {
    throw new Error('アクセスが集中しています。少し時間をおいてからもう一度お試しください');
  }
  cache.put(key, String(current + 1), limit.windowSeconds + 5);
}

function handleRequest_(params, action) {
  const idemKey = params._idemKey ? String(params._idemKey) : '';
  const cache = idemKey ? CacheService.getScriptCache() : null;

  if (cache) {
    const existing = cache.get('idem_' + idemKey);
    if (existing === 'PROCESSING') {
      // 同じ操作の別リクエスト(再試行など)がまだ処理中。先行リクエストの結果を少し待って再利用する
      for (let i = 0; i < IDEM_WAIT_ATTEMPTS; i++) {
        Utilities.sleep(IDEM_WAIT_INTERVAL_MS);
        const done = cache.get('idem_' + idemKey);
        if (done && done !== 'PROCESSING') return jsonResponse_(JSON.parse(done));
      }
      return jsonResponse_({ ok: false, error: '処理中です。少し待ってからもう一度お試しください' });
    }
    if (existing) return jsonResponse_(JSON.parse(existing));
    cache.put('idem_' + idemKey, 'PROCESSING', IDEM_CACHE_TTL_SECONDS);
  }

  let response;
  try {
    switch (action) {
      case 'getConfig':
        response = { ok: true, result: getPublicConfig_() };
        break;
      case 'issueCoupon':
        checkRateLimit_(action);
        response = { ok: true, result: issueCoupon_(params) };
        break;
      case 'checkCoupons':
        checkRateLimit_(action);
        response = { ok: true, result: checkCoupons_(params) };
        break;
      case 'markUsed':
        checkRateLimit_(action);
        response = { ok: true, result: markUsed_(params) };
        break;
      case 'searchByName':
        checkRateLimit_(action);
        response = { ok: true, result: searchByName_(params) };
        break;
      case 'adminLogin':
        checkRateLimit_(action);
        response = { ok: true, result: adminLogin_(params) };
        break;
      case 'adminList':
        requireToken_(params);
        response = { ok: true, result: adminList_(params) };
        break;
      case 'adminUpdateConfig':
        requireToken_(params);
        response = { ok: true, result: updateConfig_(params) };
        break;
      case 'adminChangePassword':
        requireToken_(params);
        response = { ok: true, result: changePassword_(params) };
        break;
      default:
        response = { ok: false, error: '不明なactionです: ' + action };
    }
  } catch (err) {
    response = { ok: false, error: String(err.message || err) };
  }

  if (cache) {
    if (response.ok) {
      // 成功時は結果をキャッシュする(再試行が同じ書き込み処理を重複実行しないようにするため)
      cache.put('idem_' + idemKey, JSON.stringify(response), IDEM_CACHE_TTL_SECONDS);
    } else {
      // 業務エラーはこの時点で副作用が発生していないため、PROCESSINGを解除して再試行時に再実行させる
      cache.remove('idem_' + idemKey);
    }
  }
  return jsonResponse_(response);
}

function jsonResponse_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

// ---- 設定管理(Script Properties) ----
function getSettings_() {
  const props = PropertiesService.getScriptProperties();
  const stored = props.getProperty('SETTINGS');
  if (!stored) {
    props.setProperty('SETTINGS', JSON.stringify(DEFAULT_SETTINGS));
    return { ...DEFAULT_SETTINGS };
  }
  return { ...DEFAULT_SETTINGS, ...JSON.parse(stored) };
}

function saveSettings_(settings) {
  PropertiesService.getScriptProperties().setProperty('SETTINGS', JSON.stringify(settings));
}

function getPublicConfig_() {
  const s = getSettings_();
  return {
    gameDuration: s.gameDuration,
    pointsPerPizza: s.pointsPerPizza,
    couponScoreThreshold: s.couponScoreThreshold,
    tiers: s.tiers,
    couponValidMonths: s.couponValidMonths,
    storeName: s.storeName,
    // 管理画面の設定タブ表示用(このゲーム自体はこの値を使わない)
    maxCouponsTotal: s.maxCouponsTotal,
    maxCouponsPerDay: s.maxCouponsPerDay,
  };
}

function updateConfig_(params) {
  const s = getSettings_();
  if (params.gameDuration !== undefined) s.gameDuration = Number(params.gameDuration) || s.gameDuration;
  if (params.pointsPerPizza !== undefined) s.pointsPerPizza = Number(params.pointsPerPizza) || s.pointsPerPizza;
  if (params.couponScoreThreshold !== undefined) s.couponScoreThreshold = Number(params.couponScoreThreshold) || s.couponScoreThreshold;
  if (params.tiers !== undefined && Array.isArray(params.tiers)) {
    s.tiers = TIER_LABELS.map((label, i) => {
      const p = params.tiers[i] || {};
      return {
        label,
        name: sanitizeText_(String(p.name || '').trim()) || label,
        weight: Math.max(Number(p.weight) || 0, 0), // 0を許容(0=その等を抽選から除外)
      };
    });
  }
  if (params.couponValidMonths !== undefined) s.couponValidMonths = Number(params.couponValidMonths) || s.couponValidMonths;
  if (params.storeName !== undefined) s.storeName = sanitizeText_(String(params.storeName).trim());
  if (params.maxCouponsTotal !== undefined) s.maxCouponsTotal = Math.max(Number(params.maxCouponsTotal) || 0, 0);
  if (params.maxCouponsPerDay !== undefined) s.maxCouponsPerDay = Math.max(Number(params.maxCouponsPerDay) || 0, 0);
  saveSettings_(s);
  return { updated: true };
}

function changePassword_(params) {
  const s = getSettings_();
  if (hashPassword_(String(params.currentPassword || '')) !== s.adminPasswordHash) {
    throw new Error('現在のパスワードが違います');
  }
  const newPassword = String(params.newPassword || '');
  if (!newPassword) throw new Error('新しいパスワードを入力してください');
  s.adminPasswordHash = hashPassword_(newPassword);
  saveSettings_(s);
  return { updated: true };
}

function hashPassword_(password) {
  const digest = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, password, Utilities.Charset.UTF_8);
  return digest.map((b) => (b < 0 ? b + 256 : b).toString(16).padStart(2, '0')).join('');
}

// ---- 管理者トークン(CacheService) ----
function adminLogin_(params) {
  const s = getSettings_();
  const password = String(params.password || '');
  if (hashPassword_(password) !== s.adminPasswordHash) {
    throw new Error('パスワードが違います');
  }
  const token = Utilities.getUuid();
  CacheService.getScriptCache().put('token_' + token, '1', TOKEN_TTL_SECONDS);
  return { token };
}

function requireToken_(params) {
  const token = params.token;
  if (!token || !CacheService.getScriptCache().get('token_' + token)) {
    throw new Error('認証が必要です。再度ログインしてください');
  }
}

// ---- スプレッドシート操作 ----
function getSheet_() {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_NAME);
  if (!sheet) throw new Error('シート「' + SHEET_NAME + '」が見つかりません。README を参照して作成してください');
  ensureSheetSchema_(sheet);
  return sheet;
}

// H列(使用日時)が無い古いシートでも自動で見出しを追加する(手動でのシート編集を不要にするため)
function ensureSheetSchema_(sheet) {
  const header = sheet.getRange(1, COLS.usedAt).getValue();
  if (!header) {
    sheet.getRange(1, COLS.usedAt).setValue('使用日時');
  }
}

const COLS = { issuedAt: 1, name: 2, code: 3, score: 4, expiresAt: 5, tier: 6, prizeName: 7, usedAt: 8 };
const SHEET_COLUMN_COUNT = 8;

function issueCoupon_(params) {
  const s = getSettings_();
  const score = Number(params.score) || 0;
  if (score < s.couponScoreThreshold) {
    throw new Error('スコアがクーポン取得の条件を満たしていません');
  }

  const name = sanitizeText_(String(params.name || '').trim());
  if (!name) throw new Error('お名前を入力してください');

  const sheet = getSheet_();
  const existingRows = readAllRows_(sheet);

  if (s.maxCouponsTotal > 0 && existingRows.length >= s.maxCouponsTotal) {
    throw new Error('景品の配布数が上限に達しました。スタッフにお問い合わせください');
  }
  if (s.maxCouponsPerDay > 0) {
    const now0 = new Date();
    const issuedToday = existingRows.filter((r) => isSameDay_(r[COLS.issuedAt - 1], now0)).length;
    if (issuedToday >= s.maxCouponsPerDay) {
      throw new Error('本日分の景品配布は終了しました。また明日挑戦してね');
    }
  }

  const drawn = drawTier_(s.tiers, score);

  const code = generateCouponCode_(sheet, existingRows);
  const now = new Date();
  const expiresAt = new Date(now);
  expiresAt.setMonth(expiresAt.getMonth() + s.couponValidMonths);

  sheet.appendRow([now, name, code, score, expiresAt, drawn.tier, drawn.name, '']);

  return {
    code,
    tier: drawn.tier,
    prizeName: drawn.name,
    score,
    issuedAt: now.getTime(),
    expiresAt: expiresAt.getTime(),
  };
}

// ガチャ抽選: tiersは[特等,1等,2等,3等]の固定順(先頭がもっともレア)。weight<=0の等は抽選から除外する。
// スコアが高いほど、レアな等(配列の先頭側)の実効重みが大きく増すように補正する
function drawTier_(tiers, score) {
  const source = Array.isArray(tiers) && tiers.length ? tiers : DEFAULT_SETTINGS.tiers;
  const list = source.filter((t) => (Number(t.weight) || 0) > 0);
  if (!list.length) return { tier: source[source.length - 1].label, name: source[source.length - 1].name };

  const weights = list.map((t, i) => {
    const rarityRank = list.length - 1 - i; // 先頭(レア)ほど大きい値
    return Math.max(Number(t.weight) || 0, 0) + rarityRank * (score / 50);
  });
  const total = weights.reduce((a, b) => a + b, 0);
  let r = Math.random() * total;
  for (let i = 0; i < list.length; i++) {
    r -= weights[i];
    if (r <= 0) return { tier: list[i].label, name: list[i].name };
  }
  const last = list[list.length - 1];
  return { tier: last.label, name: last.name };
}

// 紛らわしい文字(I, O, 0, 1)を除いたコード生成。重複時は再生成する
function generateCouponCode_(sheet, existingRows) {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const existing = new Set((existingRows || readAllRows_(sheet)).map((r) => r[COLS.code - 1]));
  let code;
  do {
    let body = '';
    for (let i = 0; i < 3; i++) {
      body += chars[Math.floor(Math.random() * chars.length)];
    }
    code = 'PZ-' + body;
  } while (existing.has(code));
  return code;
}

function readAllRows_(sheet) {
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return [];
  return sheet.getRange(2, 1, lastRow - 1, SHEET_COLUMN_COUNT).getValues();
}

function adminList_(params) {
  const sheet = getSheet_();
  const rows = readAllRows_(sheet);
  const search = String(params.search || '').trim().toLowerCase();

  const list = rows
    .map((r, i) => ({
      rowIndex: i + 2,
      issuedAt: r[COLS.issuedAt - 1] instanceof Date ? r[COLS.issuedAt - 1].getTime() : r[COLS.issuedAt - 1],
      name: r[COLS.name - 1],
      code: r[COLS.code - 1],
      score: r[COLS.score - 1],
      expiresAt: r[COLS.expiresAt - 1] instanceof Date ? r[COLS.expiresAt - 1].getTime() : r[COLS.expiresAt - 1],
      tier: r[COLS.tier - 1],
      prizeName: r[COLS.prizeName - 1],
      usedAt: r[COLS.usedAt - 1] instanceof Date ? r[COLS.usedAt - 1].getTime() : (r[COLS.usedAt - 1] || null),
    }))
    .filter((c) => {
      if (!search) return true;
      return (
        String(c.name).toLowerCase().includes(search) ||
        String(c.code).toLowerCase().includes(search)
      );
    })
    .sort((a, b) => b.issuedAt - a.issuedAt);

  return { coupons: list };
}

// お客様のゲーム端末に記憶されたコード一覧を照会し、期限内・未使用・使用済み・期限切れの状態を返す
// (この端末の記憶を失っても、スタッフが管理画面から直接「使用済みにする」ことができるため、
//  この照会自体には認証を要求していない。issueCoupon_ と同じ考え方)
function checkCoupons_(params) {
  const sheet = getSheet_();
  const rows = readAllRows_(sheet);
  const codes = String(params.codes || '')
    .split(',')
    .map((c) => c.trim())
    .filter(Boolean);
  if (!codes.length) return { coupons: [] };

  const codeSet = new Set(codes);
  const now = new Date();

  const list = rows
    .filter((r) => codeSet.has(String(r[COLS.code - 1])))
    .map((r) => {
      const expiresAt = r[COLS.expiresAt - 1];
      const usedAtRaw = r[COLS.usedAt - 1];
      let status = 'valid';
      if (usedAtRaw) status = 'used';
      else if (now > new Date(expiresAt)) status = 'expired';
      return {
        code: r[COLS.code - 1],
        name: r[COLS.name - 1],
        tier: r[COLS.tier - 1],
        prizeName: r[COLS.prizeName - 1],
        issuedAt: r[COLS.issuedAt - 1] instanceof Date ? r[COLS.issuedAt - 1].getTime() : r[COLS.issuedAt - 1],
        expiresAt: expiresAt instanceof Date ? expiresAt.getTime() : expiresAt,
        status,
      };
    });

  return { coupons: list };
}

// 保護者氏名でクーポンを検索する(端末の記憶が消えた/別端末で遊んだお客様が、自分でクーポンを呼び出すための手段)
// 完全一致(空白の有無・全角半角スペースの違いは無視)のみヒットさせる。期限内・未使用のものだけ返す
function searchByName_(params) {
  const name = String(params.name || '').trim();
  if (!name) throw new Error('お名前を入力してください');

  const normalized = normalizeName_(name);
  const sheet = getSheet_();
  const rows = readAllRows_(sheet);
  const now = new Date();

  const list = rows
    .filter((r) => normalizeName_(String(r[COLS.name - 1])) === normalized)
    .map((r) => {
      const expiresAt = r[COLS.expiresAt - 1];
      const usedAtRaw = r[COLS.usedAt - 1];
      let status = 'valid';
      if (usedAtRaw) status = 'used';
      else if (now > new Date(expiresAt)) status = 'expired';
      return {
        code: r[COLS.code - 1],
        tier: r[COLS.tier - 1],
        prizeName: r[COLS.prizeName - 1],
        issuedAt: r[COLS.issuedAt - 1] instanceof Date ? r[COLS.issuedAt - 1].getTime() : r[COLS.issuedAt - 1],
        expiresAt: expiresAt instanceof Date ? expiresAt.getTime() : expiresAt,
        status,
      };
    })
    .filter((c) => c.status === 'valid'); // お客様向けの検索結果なので、使用済み・期限切れは表示しない

  return { coupons: list };
}

function normalizeName_(name) {
  return String(name).replace(/[\s　]+/g, '').toLowerCase();
}

// クーポンを「使用済み」にする(ゲーム端末からスタッフが操作する場合と、管理画面から操作する場合の両方で使う共通処理)
function markUsed_(params) {
  const code = String(params.code || '').trim();
  if (!code) throw new Error('クーポン番号を指定してください');

  const sheet = getSheet_();
  const rowIndex = findRowIndexByCode_(sheet, code);
  if (!rowIndex) throw new Error('クーポンが見つかりません(コード: ' + code + ')');

  const usedAtCell = sheet.getRange(rowIndex, COLS.usedAt);
  if (usedAtCell.getValue()) {
    throw new Error('このクーポンはすでに使用済みです');
  }

  const now = new Date();
  usedAtCell.setValue(now);
  return { code, usedAt: now.getTime() };
}

// クーポン番号からシート上の行番号(1始まり)を探す。見つからなければnull
function findRowIndexByCode_(sheet, code) {
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return null;
  const codes = sheet.getRange(2, COLS.code, lastRow - 1, 1).getValues();
  for (let i = 0; i < codes.length; i++) {
    if (String(codes[i][0]) === code) return i + 2;
  }
  return null;
}

function isSameDay_(a, b) {
  const da = new Date(a);
  const db = new Date(b);
  return da.getFullYear() === db.getFullYear() && da.getMonth() === db.getMonth() && da.getDate() === db.getDate();
}

// スプレッドシート数式インジェクション対策(先頭が =+-@ の場合はシングルクォートを付与)
function sanitizeText_(text) {
  if (/^[=+\-@]/.test(text)) return "'" + text;
  return text;
}
