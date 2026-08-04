// api.js - Google Apps Script(GAS)との通信を行う共通モジュール
//
// GASのWebアプリはCORSのプリフライト(OPTIONS)に対応していないため、
// POST送信時は Content-Type: text/plain で JSON文字列をそのまま送る
// (これによりブラウザは「シンプルリクエスト」として扱い、プリフライトを発生させない)。
// GAS側では e.postData.contents を JSON.parse して読み取る。

const Api = (function () {
  const ADMIN_TOKEN_KEY = 'kg_admin_token';
  const MAX_RETRIES = 2; // 通信エラー時の自動再試行回数
  const RETRY_DELAY_MS = 700;

  function isConfigured() {
    return !!(GAS_CONFIG && GAS_CONFIG.WEB_APP_URL);
  }

  function getToken() {
    return sessionStorage.getItem(ADMIN_TOKEN_KEY) || '';
  }

  function setToken(token) {
    if (token) sessionStorage.setItem(ADMIN_TOKEN_KEY, token);
    else sessionStorage.removeItem(ADMIN_TOKEN_KEY);
  }

  function wait(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  // GAS無料枠は応答が一時的に不安定になることがあるため、
  // 通信エラー・応答解析エラーのみ自動で再試行する(業務エラーは再試行しない)
  async function withRetry(fn) {
    let lastErr;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        return await fn();
      } catch (err) {
        lastErr = err;
        if (!err.retryable || attempt === MAX_RETRIES) throw err;
        await wait(RETRY_DELAY_MS);
      }
    }
    throw lastErr;
  }

  async function get(action, params = {}) {
    if (!isConfigured()) throw new Error('GASのURLが未設定です(js/config.jsを確認してください)');
    return withRetry(async () => {
      const url = new URL(GAS_CONFIG.WEB_APP_URL);
      url.searchParams.set('action', action);
      Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
      const token = getToken();
      if (token) url.searchParams.set('token', token);

      const res = await fetchOrThrow(url.toString(), { method: 'GET' });
      return parseResponse(res);
    });
  }

  async function post(action, payload = {}) {
    if (!isConfigured()) throw new Error('GASのURLが未設定です(js/config.jsを確認してください)');
    return withRetry(async () => {
      const body = { action, token: getToken(), ...payload };
      const res = await fetchOrThrow(GAS_CONFIG.WEB_APP_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify(body),
      });
      return parseResponse(res);
    });
  }

  async function fetchOrThrow(url, options) {
    try {
      return await fetch(url, options);
    } catch (e) {
      const err = new Error('サーバーと通信できませんでした');
      err.retryable = true;
      throw err;
    }
  }

  async function parseResponse(res) {
    let data;
    try {
      data = await res.json();
    } catch (e) {
      const err = new Error('サーバーからの応答を解析できませんでした');
      err.retryable = true;
      throw err;
    }
    if (!data.ok) {
      throw new Error(data.error || 'サーバーでエラーが発生しました');
    }
    return data.result;
  }

  return { isConfigured, getToken, setToken, get, post };
})();
