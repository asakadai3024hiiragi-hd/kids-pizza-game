/**
 * Code.gs - ピザ職人チャレンジ バックエンド(Google Apps Script)
 *
 * このスクリプトをスプレッドシートに紐づけたApps Scriptプロジェクトとして貼り付け、
 * ウェブアプリとして公開してください。手順はプロジェクトルートの README.md を参照。
 *
 * スプレッドシートには "Coupons" という名前のシートを用意し、1行目に以下の見出しを入れてください。
 * 発行日時 | 保護者氏名 | クーポン番号 | スコア | 有効期限 | 当選景品 | 最終使用日時 | 使用回数
 */

const SHEET_NAME = 'Coupons';
const TOKEN_TTL_SECONDS = 60 * 60 * 2; // 管理者トークンの有効期限(2時間)

// ---- 既定の設定値(初回アクセス時にScript Propertiesへ書き込まれる) ----
const DEFAULT_SETTINGS = {
  gameDuration: 30,           // ゲーム時間(秒)
  pointsPerPizza: 20,         // ピザ1個完成あたりの得点
  couponScoreThreshold: 100,  // クーポン取得に必要な得点
  // ガチャの景品(5種)。景品5に近いほどレア(スコアが高いほど当たりやすくなる)。weightは基本の当たりやすさ
  prizes: [
    { name: 'ジェラート無料券', weight: 50 },
    { name: 'ドリンク無料券', weight: 30 },
    { name: '次回来店10%OFF券', weight: 15 },
    { name: 'デザートプレート無料券', weight: 4 },
    { name: '特製ピザ無料券', weight: 1 },
  ],
  couponValidMonths: 3,       // クーポン有効期間(発行日から何ヶ月か)
  storeName: '',              // 発行店舗名(クーポン画面に表示。空欄なら非表示)
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

function handleRequest_(params, action) {
  const idemKey = params._idemKey ? String(params._idemKey) : '';
  if (idemKey) {
    const cached = CacheService.getScriptCache().get('idem_' + idemKey);
    if (cached) return jsonResponse_(JSON.parse(cached));
  }

  let response;
  try {
    switch (action) {
      case 'getConfig':
        response = { ok: true, result: getPublicConfig_() };
        break;
      case 'issueCoupon':
        response = { ok: true, result: issueCoupon_(params) };
        break;
      case 'useCouponSelf':
        response = { ok: true, result: useCouponSelf_(params) };
        break;
      case 'adminLogin':
        response = { ok: true, result: adminLogin_(params) };
        break;
      case 'adminList':
        requireToken_(params);
        response = { ok: true, result: adminList_(params) };
        break;
      case 'adminMarkUsed':
        requireToken_(params);
        response = { ok: true, result: setCouponUsed_(params.code, true) };
        break;
      case 'adminUnmarkUsed':
        requireToken_(params);
        response = { ok: true, result: setCouponUsed_(params.code, false) };
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

  // 成功時のみキャッシュする(再試行が同じ書き込み処理を重複実行しないようにするため)。
  // 業務エラーはこの時点で副作用が発生していないため、キャッシュせず再試行時に再実行させて問題ない
  if (idemKey && response.ok) {
    CacheService.getScriptCache().put('idem_' + idemKey, JSON.stringify(response), IDEM_CACHE_TTL_SECONDS);
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
    prizes: s.prizes,
    couponValidMonths: s.couponValidMonths,
    storeName: s.storeName,
  };
}

function updateConfig_(params) {
  const s = getSettings_();
  if (params.gameDuration !== undefined) s.gameDuration = Number(params.gameDuration) || s.gameDuration;
  if (params.pointsPerPizza !== undefined) s.pointsPerPizza = Number(params.pointsPerPizza) || s.pointsPerPizza;
  if (params.couponScoreThreshold !== undefined) s.couponScoreThreshold = Number(params.couponScoreThreshold) || s.couponScoreThreshold;
  if (params.prizes !== undefined && Array.isArray(params.prizes)) {
    s.prizes = params.prizes.slice(0, 5).map((p) => ({
      name: sanitizeText_(String((p && p.name) || '').trim()) || '景品',
      weight: Math.max(Number(p && p.weight) || 1, 0.1),
    }));
  }
  if (params.couponValidMonths !== undefined) s.couponValidMonths = Number(params.couponValidMonths) || s.couponValidMonths;
  if (params.storeName !== undefined) s.storeName = sanitizeText_(String(params.storeName).trim());
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
  return sheet;
}

const COLS = { issuedAt: 1, name: 2, code: 3, score: 4, expiresAt: 5, prizeName: 6, lastUsedAt: 7, useCount: 8 };

function issueCoupon_(params) {
  const s = getSettings_();
  const score = Number(params.score) || 0;
  if (score < s.couponScoreThreshold) {
    throw new Error('スコアがクーポン取得の条件を満たしていません');
  }

  const name = sanitizeText_(String(params.name || '').trim());
  if (!name) throw new Error('お名前を入力してください');

  const prizeName = drawPrize_(s.prizes, score);

  const sheet = getSheet_();
  const code = generateCouponCode_(sheet);
  const now = new Date();
  const expiresAt = new Date(now);
  expiresAt.setMonth(expiresAt.getMonth() + s.couponValidMonths);

  sheet.appendRow([now, name, code, score, expiresAt, prizeName, '', 0]);

  return {
    code,
    prizeName,
    score,
    issuedAt: now.getTime(),
    expiresAt: expiresAt.getTime(),
  };
}

// ガチャ抽選: 景品配列のindexが大きいほどレア。スコアが高いほど後方(レア)の実効重みが増す
function drawPrize_(prizes, score) {
  const list = Array.isArray(prizes) && prizes.length ? prizes : DEFAULT_SETTINGS.prizes;
  const weights = list.map((p, i) => Math.max((Number(p.weight) || 1) + i * (score / 50), 0.1));
  const total = weights.reduce((a, b) => a + b, 0);
  let r = Math.random() * total;
  for (let i = 0; i < list.length; i++) {
    r -= weights[i];
    if (r <= 0) return list[i].name;
  }
  return list[list.length - 1].name;
}

// 紛らわしい文字(I, O, 0, 1)を除いたコード生成。重複時は再生成する
function generateCouponCode_(sheet) {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const existing = new Set(readAllRows_(sheet).map((r) => r[COLS.code - 1]));
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
  return sheet.getRange(2, 1, lastRow - 1, 8).getValues();
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
      prizeName: r[COLS.prizeName - 1],
      lastUsedAt: r[COLS.lastUsedAt - 1] instanceof Date ? r[COLS.lastUsedAt - 1].getTime() : (r[COLS.lastUsedAt - 1] || null),
      useCount: toUseCount_(r[COLS.useCount - 1]),
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

// used=true: 本日使用済みにする(使用回数を+1)。used=false: 本日分の使用を取り消す
function setCouponUsed_(code, used) {
  const sheet = getSheet_();
  const rows = readAllRows_(sheet);
  const idx = rows.findIndex((r) => r[COLS.code - 1] === code);
  if (idx === -1) throw new Error('コードが見つかりません');
  const rowIndex = idx + 2;
  const currentCount = toUseCount_(rows[idx][COLS.useCount - 1]);
  sheet.getRange(rowIndex, COLS.lastUsedAt).setValue(used ? new Date() : '');
  sheet.getRange(rowIndex, COLS.useCount).setValue(used ? currentCount + 1 : Math.max(currentCount - 1, 0));
  return { updated: true };
}

// H列の書式が古い日付形式のまま残っている場合、getValues()がDateを返すことがあるための防御
function toUseCount_(raw) {
  if (raw instanceof Date) return 0;
  return Number(raw) || 0;
}

// お客様の画面から(認証なしで)使用済みにする。クーポンコードを知っている本人のみ実行できる想定
// 有効期限内は何度でも使えるが、1日1回までの制限を設ける
function useCouponSelf_(params) {
  const code = String(params.code || '').trim().toUpperCase();
  if (!code) throw new Error('コードが指定されていません');

  const sheet = getSheet_();
  const rows = readAllRows_(sheet);
  const idx = rows.findIndex((r) => r[COLS.code - 1] === code);
  if (idx === -1) throw new Error('コードが見つかりません');

  const row = rows[idx];
  const expiresAt = row[COLS.expiresAt - 1] instanceof Date ? row[COLS.expiresAt - 1].getTime() : row[COLS.expiresAt - 1];
  if (Date.now() > expiresAt) throw new Error('このクーポンは有効期限切れです');

  const lastUsedRaw = row[COLS.lastUsedAt - 1];
  if (lastUsedRaw && isSameDay_(lastUsedRaw, new Date())) {
    throw new Error('本日は使用済みです。明日また使えます');
  }

  return setCouponUsed_(code, true);
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
