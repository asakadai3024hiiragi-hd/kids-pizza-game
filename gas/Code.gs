/**
 * Code.gs - ピザ職人チャレンジ バックエンド(Google Apps Script)
 *
 * このスクリプトをスプレッドシートに紐づけたApps Scriptプロジェクトとして貼り付け、
 * ウェブアプリとして公開してください。手順はプロジェクトルートの README.md を参照。
 *
 * スプレッドシートには "Coupons" という名前のシートを用意し、1行目に以下の見出しを入れてください。
 * 発行日時 | 保護者氏名 | クーポン番号 | スコア | 有効期限 | 利用タイミング | 使用状況 | 使用日時
 */

const SHEET_NAME = 'Coupons';
const TOKEN_TTL_SECONDS = 60 * 60 * 2; // 管理者トークンの有効期限(2時間)

// ---- 既定の設定値(初回アクセス時にScript Propertiesへ書き込まれる) ----
const DEFAULT_SETTINGS = {
  gameDuration: 30,           // ゲーム時間(秒)
  pointsPerPizza: 20,         // ピザ1個完成あたりの得点
  couponScoreThreshold: 100,  // クーポン取得に必要な得点
  rewardTextToday: 'ジェラート無料券',       // 本日中に使う場合の景品
  rewardTextNextTime: '次回来店10%OFF券',   // 次回来店時に使う場合の景品
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

function handleRequest_(params, action) {
  try {
    switch (action) {
      case 'getConfig':
        return jsonResponse_({ ok: true, result: getPublicConfig_() });
      case 'issueCoupon':
        return jsonResponse_({ ok: true, result: issueCoupon_(params) });
      case 'useCouponSelf':
        return jsonResponse_({ ok: true, result: useCouponSelf_(params) });
      case 'adminLogin':
        return jsonResponse_({ ok: true, result: adminLogin_(params) });
      case 'adminList':
        requireToken_(params);
        return jsonResponse_({ ok: true, result: adminList_(params) });
      case 'adminMarkUsed':
        requireToken_(params);
        return jsonResponse_({ ok: true, result: setCouponUsed_(params.code, true) });
      case 'adminUnmarkUsed':
        requireToken_(params);
        return jsonResponse_({ ok: true, result: setCouponUsed_(params.code, false) });
      case 'adminUpdateConfig':
        requireToken_(params);
        return jsonResponse_({ ok: true, result: updateConfig_(params) });
      case 'adminChangePassword':
        requireToken_(params);
        return jsonResponse_({ ok: true, result: changePassword_(params) });
      default:
        return jsonResponse_({ ok: false, error: '不明なactionです: ' + action });
    }
  } catch (err) {
    return jsonResponse_({ ok: false, error: String(err.message || err) });
  }
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
    rewardTextToday: s.rewardTextToday,
    rewardTextNextTime: s.rewardTextNextTime,
    couponValidMonths: s.couponValidMonths,
    storeName: s.storeName,
  };
}

function updateConfig_(params) {
  const s = getSettings_();
  if (params.gameDuration !== undefined) s.gameDuration = Number(params.gameDuration) || s.gameDuration;
  if (params.pointsPerPizza !== undefined) s.pointsPerPizza = Number(params.pointsPerPizza) || s.pointsPerPizza;
  if (params.couponScoreThreshold !== undefined) s.couponScoreThreshold = Number(params.couponScoreThreshold) || s.couponScoreThreshold;
  if (params.rewardTextToday !== undefined) s.rewardTextToday = sanitizeText_(String(params.rewardTextToday).trim()) || s.rewardTextToday;
  if (params.rewardTextNextTime !== undefined) s.rewardTextNextTime = sanitizeText_(String(params.rewardTextNextTime).trim()) || s.rewardTextNextTime;
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

const COLS = { issuedAt: 1, name: 2, code: 3, score: 4, expiresAt: 5, useTiming: 6, status: 7, usedAt: 8 };

function issueCoupon_(params) {
  const s = getSettings_();
  const score = Number(params.score) || 0;
  if (score < s.couponScoreThreshold) {
    throw new Error('スコアがクーポン取得の条件を満たしていません');
  }

  const name = sanitizeText_(String(params.name || '').trim());
  if (!name) throw new Error('お名前を入力してください');

  const useTiming = params.useTiming === 'next' ? 'next' : 'today';
  const useTimingLabel = useTiming === 'next' ? '次回' : '本日';
  const rewardText = useTiming === 'next' ? s.rewardTextNextTime : s.rewardTextToday;

  const sheet = getSheet_();
  const code = generateCouponCode_(sheet);
  const now = new Date();
  const expiresAt = new Date(now);
  expiresAt.setMonth(expiresAt.getMonth() + s.couponValidMonths);

  sheet.appendRow([now, name, code, score, expiresAt, useTimingLabel, '未使用', '']);

  return {
    code,
    rewardText,
    useTiming,
    score,
    issuedAt: now.getTime(),
    expiresAt: expiresAt.getTime(),
  };
}

// 紛らわしい文字(I, O, 0, 1)を除いたコード生成。重複時は再生成する
function generateCouponCode_(sheet) {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const existing = new Set(readAllRows_(sheet).map((r) => r[COLS.code - 1]));
  let code;
  do {
    let body = '';
    for (let i = 0; i < 6; i++) {
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
      useTiming: r[COLS.useTiming - 1],
      status: r[COLS.status - 1],
      usedAt: r[COLS.usedAt - 1] instanceof Date ? r[COLS.usedAt - 1].getTime() : r[COLS.usedAt - 1],
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

function setCouponUsed_(code, used) {
  const sheet = getSheet_();
  const rows = readAllRows_(sheet);
  const idx = rows.findIndex((r) => r[COLS.code - 1] === code);
  if (idx === -1) throw new Error('コードが見つかりません');
  const rowIndex = idx + 2;
  sheet.getRange(rowIndex, COLS.status).setValue(used ? '使用済み' : '未使用');
  sheet.getRange(rowIndex, COLS.usedAt).setValue(used ? new Date() : '');
  return { updated: true };
}

// お客様の画面から(認証なしで)使用済みにする。クーポンコードを知っている本人のみ実行できる想定
function useCouponSelf_(params) {
  const code = String(params.code || '').trim().toUpperCase();
  if (!code) throw new Error('コードが指定されていません');

  const sheet = getSheet_();
  const rows = readAllRows_(sheet);
  const idx = rows.findIndex((r) => r[COLS.code - 1] === code);
  if (idx === -1) throw new Error('コードが見つかりません');

  const row = rows[idx];
  if (row[COLS.status - 1] === '使用済み') throw new Error('このクーポンは既に使用済みです');
  const expiresAt = row[COLS.expiresAt - 1] instanceof Date ? row[COLS.expiresAt - 1].getTime() : row[COLS.expiresAt - 1];
  if (Date.now() > expiresAt) throw new Error('このクーポンは有効期限切れです');

  return setCouponUsed_(code, true);
}

// スプレッドシート数式インジェクション対策(先頭が =+-@ の場合はシングルクォートを付与)
function sanitizeText_(text) {
  if (/^[=+\-@]/.test(text)) return "'" + text;
  return text;
}
