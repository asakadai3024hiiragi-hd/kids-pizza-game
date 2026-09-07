/**
 * Code.gs - ピザ職人チャレンジ バックエンド(Google Apps Script)
 *
 * このスクリプトをスプレッドシートに紐づけたApps Scriptプロジェクトとして貼り付け、
 * ウェブアプリとして公開してください。手順はプロジェクトルートの README.md を参照。
 *
 * スプレッドシートには "Coupons" という名前のシートを用意し、1行目に以下の見出しを入れてください。
 * 発行日時 | 保護者氏名 | クーポン番号 | スコア | 有効期限 | 等 | 当選景品 | 使用日時 | 発行店舗
 *
 * H列(使用日時)・I列(発行店舗)が無い既存シートでも、初回アクセス時に自動で見出しが追加されます(ensureSheetSchema_)。
 * I列が空欄の既存行は、初回アクセス時に自動でDEFAULT_STORE(既定の店舗名)が補完されます。
 *
 * クーポンの利用確認は、お客様のゲーム端末に表示される「クーポン確認」画面をスタッフが目視で確認し、
 * 「使用済みにする」操作(ゲーム端末 or 管理画面のどちらからでも可)を行うことで一度きりの利用に制限します。
 *
 * ---- 複数店舗対応について ----
 * 店舗ごとに別のスプレッドシート・GASを用意するのではなく、1つのシート・1つのGASを複数店舗で共有する方式。
 * リクエストの `store` パラメータ(店舗名の文字列そのもの)で全データを絞り込む。
 * 未指定時はDEFAULT_STOREにフォールバックするため、今のところ唯一の稼働店舗である朝霞台店の
 * QRコード・URL・管理画面URL(?storeパラメータ無し)は今まで通り何も変える必要が無い。
 * 新しい店舗を追加するときは、その店舗用のQRコード(URLに `?store=新しい店舗名` を付けたもの)を
 * 新規に発行するだけでよく、コードの変更・再デプロイは不要。
 */

const SHEET_NAME = 'Coupons';
const TOKEN_TTL_SECONDS = 60 * 60 * 2; // 管理者トークンの有効期限(2時間)
const TIER_LABELS = ['特等', '1等', '2等', '3等', '4等']; // 取得確率が低い順(特等が最もレア)
// 店舗未指定のリクエスト(今までの朝霞台店のQR・管理画面URLなど)が向かう既定の店舗名。
// フロントエンド側(js/config.js の STORE_NAME)の既定値と必ず同じ文字列にすること。
const DEFAULT_STORE = '朝霞台店';

// ---- 既定の設定値(初回アクセス時にScript Propertiesへ書き込まれる) ----
const DEFAULT_SETTINGS = {
  gameDuration: 30,           // ゲーム時間(秒)
  pointsPerPizza: 20,         // ピザ1個完成あたりの得点
  couponScoreThreshold: 100,  // クーポン取得に必要な得点
  // ガチャの景品(特等/1等/2等/3等/4等の5段階)。weight=0にするとその等は抽選から除外される(4等は既定で未使用)
  tiers: [
    { label: '特等', name: '特製ピザ無料券', weight: 1 },
    { label: '1等', name: 'デザートプレート無料券', weight: 4 },
    { label: '2等', name: 'ドリンク無料券', weight: 15 },
    { label: '3等', name: 'ジェラート無料券', weight: 30 },
    { label: '4等', name: '', weight: 0 },
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
  hqLogin: { max: 10, windowSeconds: 60 }, // 本部パスワードの総当たり対策
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
        response = { ok: true, result: getPublicConfig_(resolveStore_(params)) };
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
      case 'hqLogin':
        checkRateLimit_(action);
        response = { ok: true, result: hqLogin_(params) };
        break;
      case 'adminList':
        // 認証済みトークンに紐づく店舗のデータだけを見せる(paramsの store は信用しない)。
        // 本部トークンの場合だけ、params.store で見る店舗を選べる(空欄なら全店舗合算)
        response = { ok: true, result: adminList_(params, requireToken_(params)) };
        break;
      case 'adminUpdateConfig':
        response = { ok: true, result: updateConfig_(params, requireToken_(params)) };
        break;
      case 'adminChangePassword':
        response = { ok: true, result: changePassword_(params, requireToken_(params)) };
        break;
      case 'hqChangePassword':
        response = { ok: true, result: hqChangePassword_(params, requireToken_(params)) };
        break;
      case 'hqDeleteStore':
        response = { ok: true, result: hqDeleteStore_(params, requireToken_(params)) };
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
// 店舗ごとに設定(景品内容・パスワード等)を持てるようにする。
// 複数店舗対応の前は「SETTINGS」という単一キーに1店舗ぶんの設定だけが入っていたため、
// 初回アクセス時にその内容をDEFAULT_STOREの設定として自動移行する(移行後は使わないが、
// 事故防止のため元の「SETTINGS」プロパティ自体は残したままにする)
function getAllSettings_() {
  const props = PropertiesService.getScriptProperties();
  const stored = props.getProperty('SETTINGS_BY_STORE');
  if (stored) return JSON.parse(stored);

  const legacy = props.getProperty('SETTINGS');
  const all = {};
  all[DEFAULT_STORE] = legacy ? { ...DEFAULT_SETTINGS, ...JSON.parse(legacy) } : { ...DEFAULT_SETTINGS };
  saveAllSettings_(all);
  return all;
}

function saveAllSettings_(all) {
  PropertiesService.getScriptProperties().setProperty('SETTINGS_BY_STORE', JSON.stringify(all));
}

// リクエストパラメータから店舗名を取り出す。未指定なら既定の店舗(DEFAULT_STORE)として扱う
function resolveStore_(params) {
  return String((params && params.store) || '').trim() || DEFAULT_STORE;
}

function getSettings_(store) {
  const all = getAllSettings_();
  if (!all[store]) {
    // 初めて出てくる店舗名。既定値+その店舗名で新規登録する(初期パスワードはadmin123)
    all[store] = { ...DEFAULT_SETTINGS, storeName: store };
    saveAllSettings_(all);
  }
  return all[store];
}

function saveSettings_(store, settings) {
  const all = getAllSettings_();
  all[store] = settings;
  saveAllSettings_(all);
}

function getPublicConfig_(store) {
  const s = getSettings_(store);
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

function updateConfig_(params, tokenStore) {
  const store = resolveEditableStore_(params, tokenStore);
  const s = getSettings_(store);
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
  saveSettings_(store, s);
  return { updated: true };
}

function changePassword_(params, tokenStore) {
  const store = resolveEditableStore_(params, tokenStore);
  const s = getSettings_(store);
  if (hashPassword_(String(params.currentPassword || '')) !== s.adminPasswordHash) {
    throw new Error('現在のパスワードが違います');
  }
  const newPassword = String(params.newPassword || '');
  if (!newPassword) throw new Error('新しいパスワードを入力してください');
  s.adminPasswordHash = hashPassword_(newPassword);
  saveSettings_(store, s);
  return { updated: true };
}

function hashPassword_(password) {
  const digest = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, password, Utilities.Charset.UTF_8);
  return digest.map((b) => (b < 0 ? b + 256 : b).toString(16).padStart(2, '0')).join('');
}

// ---- 管理者トークン(CacheService) ----
function adminLogin_(params) {
  const store = resolveStore_(params);
  const s = getSettings_(store);
  const password = String(params.password || '');
  if (hashPassword_(password) !== s.adminPasswordHash) {
    throw new Error('パスワードが違います');
  }
  const token = Utilities.getUuid();
  // トークンの値そのものに「どの店舗にログインしたか」を持たせる。
  // これにより、ログイン後の各操作はクライアントが申告するstoreを信用せず、
  // このトークンに紐づく店舗だけを対象にできる(他店舗のデータを覗かれない)
  CacheService.getScriptCache().put('token_' + token, store, TOKEN_TTL_SECONDS);
  return { token };
}

// 認証を必須にし、そのトークンに紐づく店舗名(本部トークンの場合はHQ_TOKEN_MARKER_)を返す
function requireToken_(params) {
  const token = params.token;
  const store = token && CacheService.getScriptCache().get('token_' + token);
  if (!store) {
    throw new Error('認証が必要です。再度ログインしてください');
  }
  return store;
}

// ---- 本部(全店舗横断)管理者 ----
// 店舗ごとのパスワードとは別に、全店舗を横断して閲覧・設定変更できる本部専用のパスワードを用意する。
// トークンの中身にこの特別な値(実在の店舗名としては絶対に使われない記号)を入れることで、
// 「これは本部トークンだ」と区別できるようにする。
const HQ_TOKEN_MARKER_ = '__HQ__';

function isHqToken_(tokenStore) {
  return tokenStore === HQ_TOKEN_MARKER_;
}

function getHqPasswordHash_() {
  const props = PropertiesService.getScriptProperties();
  const stored = props.getProperty('HQ_PASSWORD_HASH');
  if (stored) return stored;
  // 初回アクセス時に初期パスワード(admin123)で作成する。各店舗のパスワードと同様、必ず変更してください
  const initial = hashPassword_('admin123');
  props.setProperty('HQ_PASSWORD_HASH', initial);
  return initial;
}

function setHqPasswordHash_(hash) {
  PropertiesService.getScriptProperties().setProperty('HQ_PASSWORD_HASH', hash);
}

function hqLogin_(params) {
  const password = String(params.password || '');
  if (hashPassword_(password) !== getHqPasswordHash_()) {
    throw new Error('パスワードが違います');
  }
  const token = Utilities.getUuid();
  CacheService.getScriptCache().put('token_' + token, HQ_TOKEN_MARKER_, TOKEN_TTL_SECONDS);
  // ログイン直後に店舗選択プルダウンを出せるよう、既知の店舗名一覧も一緒に返す
  return { token, stores: Object.keys(getAllSettings_()) };
}

function hqChangePassword_(params, tokenStore) {
  if (!isHqToken_(tokenStore)) throw new Error('本部管理者としてログインしてください');
  if (hashPassword_(String(params.currentPassword || '')) !== getHqPasswordHash_()) {
    throw new Error('現在のパスワードが違います');
  }
  const newPassword = String(params.newPassword || '');
  if (!newPassword) throw new Error('新しいパスワードを入力してください');
  setHqPasswordHash_(hashPassword_(newPassword));
  return { updated: true };
}

// 店舗の設定(景品内容・パスワード等)を削除する。本部管理者専用。
// 注意: これは「その店舗名の設定・パスワード」を削除するだけで、スプレッドシート上に
// 既に発行済みのクーポン行(発行店舗列にその店舗名が入っている行)は削除しない
// (誤操作でクーポン実績が消えることを防ぐため。行の削除は今まで通りスプレッドシートで手動対応)
function hqDeleteStore_(params, tokenStore) {
  if (!isHqToken_(tokenStore)) throw new Error('本部管理者としてログインしてください');
  const store = String(params.store || '').trim();
  if (!store) throw new Error('削除する店舗を指定してください');
  if (store === DEFAULT_STORE) throw new Error('既定の店舗(店舗名を指定しないQR用の店舗)は削除できません');
  const all = getAllSettings_();
  if (!Object.prototype.hasOwnProperty.call(all, store)) {
    throw new Error('その店舗の設定が見つかりません');
  }
  delete all[store];
  saveAllSettings_(all);
  return { deleted: true };
}

// 設定変更・パスワード変更の対象店舗を決める。
// 本部管理者は全店舗を閲覧はできるが、設定・パスワードの変更は各店舗自身の管理画面からのみ行う方針のため、
// 本部トークンでは常にエラーにする(誤って他店舗の設定を書き換えてしまう事故を防ぐ)。
function resolveEditableStore_(params, tokenStore) {
  if (isHqToken_(tokenStore)) {
    throw new Error('本部管理者は各店舗の設定を変更できません(閲覧のみです)。変更はその店舗自身の管理画面から行ってください');
  }
  return tokenStore;
}

// ---- スプレッドシート操作 ----
function getSheet_() {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_NAME);
  if (!sheet) throw new Error('シート「' + SHEET_NAME + '」が見つかりません。README を参照して作成してください');
  ensureSheetSchema_(sheet);
  return sheet;
}

// H列(使用日時)・I列(発行店舗)が無い古いシートでも自動で見出しを追加する(手動でのシート編集を不要にするため)
function ensureSheetSchema_(sheet) {
  const usedAtHeader = sheet.getRange(1, COLS.usedAt).getValue();
  if (!usedAtHeader) {
    sheet.getRange(1, COLS.usedAt).setValue('使用日時');
  }
  const storeHeader = sheet.getRange(1, COLS.store).getValue();
  if (!storeHeader) {
    sheet.getRange(1, COLS.store).setValue('発行店舗');
  }
  // 複数店舗対応を追加する前に発行された既存データはI列(発行店舗)が空欄になっているため、
  // 初回アクセス時にDEFAULT_STORE(その頃は実質これしか無かった店舗)で一括補完する。
  // 2回目以降のアクセスでは既に全部埋まっているので、この処理は何もしない(書き込みは発生しない)
  const lastRow = sheet.getLastRow();
  if (lastRow >= 2) {
    const storeRange = sheet.getRange(2, COLS.store, lastRow - 1, 1);
    const values = storeRange.getValues();
    let changed = false;
    const filled = values.map((row) => {
      if (row[0]) return row;
      changed = true;
      return [DEFAULT_STORE];
    });
    if (changed) storeRange.setValues(filled);
  }
}

const COLS = { issuedAt: 1, name: 2, code: 3, score: 4, expiresAt: 5, tier: 6, prizeName: 7, usedAt: 8, store: 9 };
const SHEET_COLUMN_COUNT = 9;

function issueCoupon_(params) {
  const store = resolveStore_(params);
  const s = getSettings_(store);
  const score = Number(params.score) || 0;
  if (score < s.couponScoreThreshold) {
    throw new Error('スコアがクーポン取得の条件を満たしていません');
  }

  const name = sanitizeText_(String(params.name || '').trim());
  if (!name) throw new Error('お名前を入力してください');

  const sheet = getSheet_();
  const existingRows = readAllRows_(sheet);
  const storeRows = existingRows.filter((r) => String(r[COLS.store - 1]) === store);

  // 同姓同名の別人が同時に未使用クーポンを抱える事故を防ぐため、
  // 同じ店舗・同じお名前(空白除去・大文字小文字統一)で「未使用・期限内」のクーポンが既にある場合は新規登録できないようにする
  // (使用済み・期限切れになれば同じお名前でまた登録できる。何度でも遊べる設計自体は変えない。他店舗の同姓同名とは無関係)
  const normalizedName = normalizeName_(name);
  const nowForCheck = new Date();
  const hasActiveCouponForName = storeRows.some((r) => {
    if (normalizeName_(String(r[COLS.name - 1])) !== normalizedName) return false;
    if (r[COLS.usedAt - 1]) return false; // 使用済みは対象外
    return nowForCheck <= new Date(r[COLS.expiresAt - 1]); // 期限内なら「有効なクーポンが既にある」
  });
  if (hasActiveCouponForName) {
    throw new Error('このお名前ではすでに未使用のクーポンをお持ちです。別のお名前でご登録いただくか、スタッフにご相談ください');
  }

  if (s.maxCouponsTotal > 0 && storeRows.length >= s.maxCouponsTotal) {
    throw new Error('景品の配布数が上限に達しました。スタッフにお問い合わせください');
  }
  if (s.maxCouponsPerDay > 0) {
    const now0 = new Date();
    const issuedToday = storeRows.filter((r) => isSameDay_(r[COLS.issuedAt - 1], now0)).length;
    if (issuedToday >= s.maxCouponsPerDay) {
      throw new Error('本日分の景品配布は終了しました。また明日挑戦してね');
    }
  }

  const drawn = drawTier_(s.tiers, score);

  const code = generateCouponCode_(sheet, existingRows); // クーポン番号は店舗をまたいで一意にする
  const now = new Date();
  const expiresAt = new Date(now);
  expiresAt.setMonth(expiresAt.getMonth() + s.couponValidMonths);

  sheet.appendRow([now, name, code, score, expiresAt, drawn.tier, drawn.name, '', store]);

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

function adminList_(params, tokenStore) {
  const sheet = getSheet_();
  const rows = readAllRows_(sheet);
  const search = String(params.search || '').trim().toLowerCase();
  // 通常の店舗トークンは必ずその店舗だけに絞り込む。
  // 本部トークンは params.store が指定されていればその店舗に絞り込み、
  // 空欄(未選択="全店舗")なら店舗を問わず全件返す(一覧に店舗列が付くので区別できる)
  const targetStore = isHqToken_(tokenStore) ? String(params.store || '').trim() : tokenStore;

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
      store: r[COLS.store - 1],
    }))
    .filter((c) => !targetStore || c.store === targetStore)
    .filter((c) => {
      if (!search) return true;
      return (
        String(c.name).toLowerCase().includes(search) ||
        String(c.code).toLowerCase().includes(search)
      );
    })
    .sort((a, b) => b.issuedAt - a.issuedAt);

  return { coupons: list, isHq: isHqToken_(tokenStore) };
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
  const store = resolveStore_(params);

  const normalized = normalizeName_(name);
  const sheet = getSheet_();
  const rows = readAllRows_(sheet);
  const now = new Date();

  const list = rows
    .filter((r) => String(r[COLS.store - 1]) === store && normalizeName_(String(r[COLS.name - 1])) === normalized)
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
