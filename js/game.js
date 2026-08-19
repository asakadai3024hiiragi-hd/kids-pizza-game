// game.js - ピザ職人チャレンジ ゲームロジック
// 生地→トマトソース→チーズ→具材の順番にタップしてピザを完成させる
(function () {
  const STEP_DEFS = [
    { key: 'dough', emoji: '🫓', label: '生地' },
    { key: 'sauce', emoji: '🍅', label: 'トマトソース' },
    { key: 'cheese', emoji: '🧀', label: 'チーズ' },
  ];
  const TOPPING_CHOICES = ['🍄', '🫑', '🍍', '🌽', '🫒', '🥓'];
  const BAD_ITEMS = ['🐛', '🔥'];
  const BAD_LOCK_SECONDS = 2;
  const GACHA_ROTATION_REQUIRED_DEG = 720; // ガチャを回し切るまでに必要な累積回転角度(2回転ぶん)
  const GACHA_CLICK_STEP_DEG = 45; // この角度回すごとに「カチッ」という手応え(音・弾む動き)を出す

  // 等級ごとの当選演出設定(特等が最も派手・長い)
  const TIER_REVEAL = {
    '特等': { theme: 'tier-grand', durationMs: 3800, confettiCount: 40, badge: '🏆 特等!!' },
    '1等': { theme: 'tier-1', durationMs: 3200, confettiCount: 26, badge: '🎉 1等!' },
    '2等': { theme: 'tier-2', durationMs: 2600, confettiCount: 16, badge: '✨ 2等!' },
    '3等': { theme: 'tier-3', durationMs: 2200, confettiCount: 8, badge: '🎊 3等!' },
    '4等': { theme: 'tier-4', durationMs: 1800, confettiCount: 4, badge: '🍕 4等!' },
  };
  const CONFETTI_COLORS = ['#ffd93d', '#ff6b6b', '#4fa3d1', '#7bc47f', '#ffffff', '#ff8a3d'];

  // GASが未設定/未応答でもゲームが遊べるようにするデフォルト設定
  const DEFAULT_CONFIG = {
    gameDuration: 30,
    pointsPerPizza: 20,
    couponScoreThreshold: 100,
    tiers: [
      { label: '特等', name: '特製ピザ無料券', weight: 1 },
      { label: '1等', name: 'デザートプレート無料券', weight: 4 },
      { label: '2等', name: 'ドリンク無料券', weight: 15 },
      { label: '3等', name: 'ジェラート無料券', weight: 30 },
    ],
    storeName: '',
  };

  const CLAIM_STORAGE_KEY = 'kg_coupon_claimed_at';
  const CLAIM_COOLDOWN_MS = 10 * 60 * 60 * 1000; // この端末での再取得までの待機時間(10時間)

  const MY_COUPONS_KEY = 'kg_my_coupons'; // この端末で取得したクーポン番号の一覧(「クーポン確認」で使う)
  const MY_COUPONS_MAX = 100; // 記憶しておくコード数の上限(無制限に増え続けないための安全弁)

  const screens = {
    start: document.getElementById('screen-start'),
    countdown: document.getElementById('screen-countdown'),
    game: document.getElementById('screen-game'),
    gacha: document.getElementById('screen-gacha'),
    prize: document.getElementById('screen-prize'),
    result: document.getElementById('screen-result'),
  };

  const el = {
    timer: document.getElementById('timer'),
    score: document.getElementById('score'),
    playArea: document.getElementById('play-area'),
    toppings: document.getElementById('pizza-toppings'),
    countdownNumber: document.getElementById('countdown-number'),
    progressSteps: document.getElementById('progress-steps'),
    nextGuide: document.getElementById('next-guide'),
    missLockOverlay: document.getElementById('miss-lock-overlay'),
    missLockCountdown: document.getElementById('miss-lock-countdown'),
    gachaMachine: document.getElementById('gacha-machine'),
    gachaCrank: document.getElementById('gacha-crank'),
    gachaCapsule: document.getElementById('gacha-capsule'),
    gachaMessage: document.getElementById('gacha-message'),
    prizeScreen: document.getElementById('screen-prize'),
    prizeConfetti: document.getElementById('prize-confetti'),
    prizeTierBadge: document.getElementById('prize-tier-badge'),
    prizeName: document.getElementById('prize-name'),
    resultTitle: document.getElementById('result-title'),
    resultStars: document.getElementById('result-stars'),
    resultScore: document.getElementById('result-score'),
    resultMessage: document.getElementById('result-message'),
    couponForm: document.getElementById('coupon-form'),
    couponFormError: document.getElementById('coupon-form-error'),
    inputName: document.getElementById('input-name'),
    btnSubmitCoupon: document.getElementById('btn-submit-coupon'),
    alreadyClaimedMessage: document.getElementById('already-claimed-message'),
    couponCard: document.getElementById('coupon-card'),
    couponTier: document.getElementById('coupon-tier'),
    couponReward: document.getElementById('coupon-reward'),
    couponPresentNote: document.getElementById('coupon-present-note'),
    couponCode: document.getElementById('coupon-code'),
    couponIssuedAt: document.getElementById('coupon-issued-at'),
    couponExpiry: document.getElementById('coupon-expiry'),
    couponStore: document.getElementById('coupon-store'),
    screenshotNote: document.getElementById('screenshot-note'),
    resultButtons: document.getElementById('result-buttons'),
    btnStart: document.getElementById('btn-start'),
    btnRetry: document.getElementById('btn-retry'),
    btnFinish: document.getElementById('btn-finish'),
    btnSoundToggle: document.getElementById('btn-sound-toggle'),

    btnCheckCoupons: document.getElementById('btn-check-coupons'),
    modalCoupons: document.getElementById('modal-coupons'),
    modalCouponsClose: document.getElementById('modal-coupons-close'),
    couponsLoading: document.getElementById('coupons-loading'),
    couponsEmpty: document.getElementById('coupons-empty'),
    searchNameInput: document.getElementById('search-name-input'),
    btnSearchName: document.getElementById('btn-search-name'),
    searchNameError: document.getElementById('search-name-error'),
    couponsError: document.getElementById('coupons-error'),
    couponsList: document.getElementById('coupons-list'),
    couponsDetail: document.getElementById('coupons-detail'),
    btnCouponDetailBack: document.getElementById('btn-coupon-detail-back'),
    detailTier: document.getElementById('detail-tier'),
    detailReward: document.getElementById('detail-reward'),
    detailPresentNote: document.getElementById('detail-present-note'),
    detailCode: document.getElementById('detail-code'),
    detailIssuedAt: document.getElementById('detail-issued-at'),
    detailExpiry: document.getElementById('detail-expiry'),
    detailConfirm: document.getElementById('detail-confirm'),
    detailConfirmCheck: document.getElementById('detail-confirm-check'),
    btnMarkUsed: document.getElementById('btn-mark-used'),
    btnMarkUsedYes: document.getElementById('btn-mark-used-yes'),
    btnMarkUsedNo: document.getElementById('btn-mark-used-no'),
    markUsedError: document.getElementById('mark-used-error'),
    markUsedSuccess: document.getElementById('mark-used-success'),
  };

  let CONFIG_CACHE = { ...DEFAULT_CONFIG };
  let score = 0;
  let timeLeft = 30;
  let gameTimerId = null;
  let currentStepIndex = 0;
  let currentRound = [];
  let currentCouponCode = null;
  let isLocked = false;
  const activeItems = [];

  function showScreen(name) {
    Object.values(screens).forEach((s) => s.classList.remove('active'));
    screens[name].classList.add('active');
  }

  async function loadConfig() {
    if (!Api.isConfigured()) return;
    try {
      const cfg = await Api.get('getConfig');
      CONFIG_CACHE = { ...DEFAULT_CONFIG, ...cfg };
    } catch (e) {
      // 取得できない場合は既定値のまま遊べるようにする
      console.warn('設定の取得に失敗したため既定値で起動します', e);
    }
  }

  function updateScoreDisplay() {
    el.score.textContent = score;
  }

  function updateSoundButton() {
    el.btnSoundToggle.textContent = Sound.isEnabled() ? '🔊' : '🔇';
  }

  el.btnSoundToggle.addEventListener('click', () => {
    Sound.setEnabled(!Sound.isEnabled());
    updateSoundButton();
  });

  // ---- ラウンド(1個のピザ)の管理 ----
  // スコアが上がるほど、必要なトッピングの種類(タップ数)が増える(難易度上昇)
  function getExtraToppingCount(currentScore) {
    return Math.min(Math.floor(currentScore / 100), 2);
  }

  function buildRoundDefs() {
    const toppingCount = 1 + getExtraToppingCount(score);
    const shuffled = [...TOPPING_CHOICES].sort(() => Math.random() - 0.5);
    const toppings = shuffled.slice(0, toppingCount).map((emoji, i) => ({
      key: 'topping' + i,
      emoji,
      label: '具材',
    }));
    return [...STEP_DEFS, ...toppings];
  }

  function startRound() {
    currentStepIndex = 0;
    currentRound = buildRoundDefs();
    updateGuide();
    renderProgressDots();
    renderRoundItems();
  }

  // 進捗表示は、その回に実際に登場する具材(トッピングが複数のときは複数個)を
  // 見た目どおりのアイコンで表示する(固定の🍕マークだと画面上の具材と一致せず分かりにくいため)
  function renderProgressDots() {
    el.progressSteps.innerHTML = '';
    currentRound.forEach((step, i) => {
      const dot = document.createElement('span');
      dot.className = 'progress-dot';
      dot.dataset.step = i;
      dot.textContent = step.emoji;
      el.progressSteps.appendChild(dot);
    });
    updateProgressDots();
  }

  function renderRoundItems() {
    clearItems();
    const order = currentRound.map((_, i) => i).sort(() => Math.random() - 0.5);
    order.forEach((stepIndex) => placeItem(stepIndex));
    for (let i = 0; i < getBadItemCount(score); i++) {
      if (Math.random() < getBadChance(score)) placeBadItem();
    }
  }

  function clearItems() {
    activeItems.forEach((item) => {
      if (item.floatIntervalId) clearInterval(item.floatIntervalId);
      item.el.remove();
    });
    activeItems.length = 0;
  }

  // スコアが上がるほど「ハズレ」が出やすくなる(難易度上昇、20点ごとに+0.04、上限0.6)
  function getBadChance(currentScore) {
    return Math.min(0.15 + Math.floor(currentScore / 20) * 0.04, 0.6);
  }

  // スコアが上がるほど「ハズレ」の出現個数が増える(100点ごとに+1、最大3個)
  function getBadItemCount(currentScore) {
    return Math.min(1 + Math.floor(currentScore / 100), 3);
  }

  // スコアが上がるほど具材の動き(フワフワ)が忙しくなる(難易度上昇、20点ごとに-60ms、下限400ms)
  function getFloatIntervalMs(currentScore) {
    return Math.max(1300 - Math.floor(currentScore / 20) * 60, 400);
  }

  function randomPosition(node) {
    const areaRect = el.playArea.getBoundingClientRect();
    const size = 68;
    const maxX = Math.max(areaRect.width - size, 10);
    const maxY = Math.max(areaRect.height * 0.55 - size, 10);
    node.style.left = Math.random() * maxX + 'px';
    node.style.top = Math.random() * maxY + 'px';
  }

  function startFloating(node) {
    const intervalId = setInterval(() => {
      if (!node.parentNode) {
        clearInterval(intervalId);
        return;
      }
      const areaRect = el.playArea.getBoundingClientRect();
      const size = 68;
      const maxX = Math.max(areaRect.width - size, 10);
      const maxY = Math.max(areaRect.height * 0.55 - size, 10);
      const curLeft = parseFloat(node.style.left) || 0;
      const curTop = parseFloat(node.style.top) || 0;
      node.style.left = Math.min(Math.max(curLeft + (Math.random() * 44 - 22), 0), maxX) + 'px';
      node.style.top = Math.min(Math.max(curTop + (Math.random() * 44 - 22), 0), maxY) + 'px';
    }, getFloatIntervalMs(score));
    const item = activeItems.find((it) => it.el === node);
    if (item) item.floatIntervalId = intervalId;
  }

  function placeItem(stepIndex) {
    const def = currentRound[stepIndex];
    const node = document.createElement('div');
    node.className = 'ingredient';
    node.textContent = def.emoji;
    randomPosition(node);

    node.addEventListener(
      'pointerdown',
      (ev) => {
        ev.preventDefault();
        handleTap(stepIndex, node);
      },
      { passive: false }
    );

    el.playArea.appendChild(node);
    activeItems.push({ el: node, stepIndex });
    startFloating(node);
  }

  function placeBadItem() {
    const emoji = BAD_ITEMS[Math.floor(Math.random() * BAD_ITEMS.length)];
    const node = document.createElement('div');
    node.className = 'ingredient bad';
    node.textContent = emoji;
    randomPosition(node);

    node.addEventListener(
      'pointerdown',
      (ev) => {
        ev.preventDefault();
        handleBadTap(node);
      },
      { passive: false }
    );

    el.playArea.appendChild(node);
    activeItems.push({ el: node, stepIndex: -1 });
    startFloating(node);
  }

  function handleTap(stepIndex, node) {
    if (isLocked) return;
    if (stepIndex === currentStepIndex) {
      Sound.playSuccess();
      node.classList.add('fade-out');
      const idx = activeItems.findIndex((it) => it.el === node);
      if (idx >= 0) {
        if (activeItems[idx].floatIntervalId) clearInterval(activeItems[idx].floatIntervalId);
        activeItems.splice(idx, 1);
      }
      setTimeout(() => node.remove(), 180);
      addTopping(currentRound[stepIndex].emoji);
      currentStepIndex += 1;
      updateProgressDots();

      if (currentStepIndex >= currentRound.length) {
        completePizza();
      } else {
        updateGuide();
      }
    } else {
      Sound.playMiss();
      node.classList.add('shake');
      setTimeout(() => node.classList.remove('shake'), 300);
    }
  }

  function handleBadTap(node) {
    if (isLocked) return;
    Sound.playMiss();
    node.classList.add('shake');
    lockPlayArea(BAD_LOCK_SECONDS);
  }

  function lockPlayArea(seconds) {
    isLocked = true;
    el.missLockOverlay.hidden = false;
    let remaining = seconds;
    el.missLockCountdown.textContent = remaining;
    const id = setInterval(() => {
      remaining -= 1;
      if (remaining <= 0) {
        clearInterval(id);
        el.missLockOverlay.hidden = true;
        isLocked = false;
      } else {
        el.missLockCountdown.textContent = remaining;
      }
    }, 1000);
  }

  function updateGuide() {
    const def = currentRound[currentStepIndex];
    if (def) el.nextGuide.textContent = `${def.label}をタップ!`;
  }

  function updateProgressDots() {
    el.progressSteps.querySelectorAll('.progress-dot').forEach((dot, i) => {
      dot.classList.toggle('done', i < currentStepIndex);
      dot.classList.toggle('active', i === currentStepIndex);
    });
  }

  function addTopping(emoji) {
    const topping = document.createElement('span');
    topping.className = 'topping';
    topping.textContent = emoji;
    const angle = Math.random() * Math.PI * 2;
    const radius = Math.random() * 36;
    topping.style.left = 50 + Math.cos(angle) * radius + '%';
    topping.style.top = 50 + Math.sin(angle) * radius + '%';
    topping.style.transform = `translate(-50%, -50%) rotate(${Math.random() * 360}deg)`;
    el.toppings.appendChild(topping);
  }

  function completePizza() {
    score += CONFIG_CACHE.pointsPerPizza;
    updateScoreDisplay();
    Sound.playClear();
    el.toppings.classList.add('pizza-complete');
    setTimeout(() => {
      el.toppings.classList.remove('pizza-complete');
      el.toppings.innerHTML = '';
      if (timeLeft > 0) startRound();
    }, 420);
  }

  // ---- ゲーム進行 ----
  // スタート/リトライがGASの応答待ち中に連打されると、カウントダウン・タイマーが
  // 二重に走ってしまう(残り時間が実時間の2倍速で減る)ため、多重起動を防止する
  let isStartingGame = false;

  async function startCountdown() {
    if (isStartingGame) return;
    isStartingGame = true;
    Sound.setEnabled(Sound.isEnabled());
    await loadConfig();
    showScreen('countdown');
    let count = 3;
    el.countdownNumber.textContent = count;
    Sound.playStart();
    const id = setInterval(() => {
      count -= 1;
      if (count <= 0) {
        clearInterval(id);
        startGame();
      } else {
        el.countdownNumber.textContent = count;
      }
    }, 700);
  }

  function startGame() {
    if (gameTimerId) clearInterval(gameTimerId);
    score = 0;
    timeLeft = CONFIG_CACHE.gameDuration;
    el.toppings.innerHTML = '';
    updateScoreDisplay();
    el.timer.textContent = timeLeft;
    showScreen('game');
    startRound();

    gameTimerId = setInterval(() => {
      timeLeft -= 1;
      el.timer.textContent = timeLeft;
      if (timeLeft <= 0) endGame();
    }, 1000);
    isStartingGame = false;
  }

  function endGame() {
    clearInterval(gameTimerId);
    clearItems();
    isLocked = false;
    el.missLockOverlay.hidden = true;
    Sound.playGameOver();
    showResult();
  }

  function evaluateScore(s) {
    if (s >= 100) return { title: '伝説のピザ職人!', stars: 5 };
    if (s >= 80) return { title: 'ピザマスター!', stars: 4 };
    if (s >= 41) return { title: 'すごい!', stars: 3 };
    return { title: 'もう一回挑戦!', stars: 1 };
  }

  function getClaimedRemainingMs() {
    const raw = localStorage.getItem(CLAIM_STORAGE_KEY);
    if (!raw) return 0;
    const remaining = Number(raw) + CLAIM_COOLDOWN_MS - Date.now();
    return remaining > 0 ? remaining : 0;
  }

  function markClaimed() {
    localStorage.setItem(CLAIM_STORAGE_KEY, String(Date.now()));
  }

  // ---- この端末で取得したクーポンの記憶(「クーポン確認」で使う) ----
  function getMyCoupons() {
    try {
      const raw = JSON.parse(localStorage.getItem(MY_COUPONS_KEY) || '[]');
      return Array.isArray(raw) ? raw.filter((c) => typeof c === 'string' && c) : [];
    } catch (e) {
      return [];
    }
  }

  function saveMyCoupons(codes) {
    localStorage.setItem(MY_COUPONS_KEY, JSON.stringify(codes.slice(-MY_COUPONS_MAX)));
  }

  function addMyCoupon(code) {
    const codes = getMyCoupons();
    if (!codes.includes(code)) {
      codes.push(code);
      saveMyCoupons(codes);
    }
  }

  function showResult() {
    showScreen('result');
    const evalResult = evaluateScore(score);
    el.resultTitle.textContent = evalResult.title;
    el.resultStars.textContent = '★'.repeat(evalResult.stars) + '☆'.repeat(5 - evalResult.stars);
    el.resultScore.textContent = `獲得スコア: ${score}点`;

    currentCouponCode = null;
    el.resultStars.hidden = false;
    el.resultScore.hidden = false;
    el.couponForm.hidden = true;
    el.couponCard.hidden = true;
    el.couponStore.hidden = true;
    el.resultMessage.hidden = true;
    el.alreadyClaimedMessage.hidden = true;
    el.screenshotNote.hidden = true;
    el.resultButtons.hidden = true;
    el.couponFormError.hidden = true;
    el.couponForm.reset();

    if (score >= CONFIG_CACHE.couponScoreThreshold) {
      const remainingMs = getClaimedRemainingMs();
      if (remainingMs > 0) {
        const hours = Math.ceil(remainingMs / (60 * 60 * 1000));
        el.alreadyClaimedMessage.hidden = false;
        el.alreadyClaimedMessage.textContent = `この端末では景品を受け取り済みです。あと約${hours}時間後にまた挑戦できます。`;
        el.resultButtons.hidden = false;
      } else {
        el.couponForm.hidden = false;
      }
    } else {
      el.resultMessage.hidden = false;
      el.resultMessage.textContent = 'あと少し!もう一度チャレンジしてね。';
      el.resultButtons.hidden = false;
    }
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

  function validateName(name) {
    const trimmed = name.trim();
    if (!trimmed) return 'お名前を入力してください';
    if (!/[^\s]/.test(trimmed)) return 'お名前を入力してください';
    return null;
  }

  el.couponForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = el.inputName.value;
    const error = validateName(name);

    el.couponFormError.hidden = !error;
    if (error) {
      el.couponFormError.textContent = error;
      return;
    }

    el.btnSubmitCoupon.disabled = true;
    el.btnSubmitCoupon.textContent = '送信中...';
    try {
      const coupon = await Api.post('issueCoupon', {
        score,
        name: name.trim(),
      });
      markClaimed();
      addMyCoupon(coupon.code);
      currentCouponCode = coupon.code;
      el.couponForm.hidden = true;
      await playGachaAnimation();
      await playPrizeReveal(coupon);
      showScreen('result');
      showCouponCard(coupon);
    } catch (err) {
      el.couponFormError.hidden = false;
      el.couponFormError.textContent = 'クーポンの発行に失敗しました。スタッフにお知らせください。(' + err.message + ')';
    } finally {
      el.btnSubmitCoupon.disabled = false;
      el.btnSubmitCoupon.textContent = 'ガチャをまわす!';
    }
  });

  // ハンドルを指でドラッグした動きに合わせてクランクが実際に回転し、
  // 累積の回転量が既定値に達するとカプセルが出てくる(タップの回数ではなく実際の指の動きに追従する)
  function playGachaAnimation() {
    return new Promise((resolve) => {
      showScreen('gacha');
      let currentAngle = 0; // 見た目の現在の回転角度(符号あり)
      let totalRotation = 0; // 進捗判定用の累積回転量(絶対値)
      let lastClickStep = 0;
      let lastPointerAngle = null;
      let dragging = false;
      let finished = false;

      el.gachaCapsule.className = 'gacha-capsule';
      el.gachaCrank.style.transform = 'translateY(-50%) rotate(0deg)';
      el.gachaCrank.classList.add('invite');
      el.gachaMessage.textContent = 'ハンドルを指でぐるぐる回してね!';

      function pivotPoint() {
        const rect = el.gachaMachine.getBoundingClientRect();
        return { x: rect.right - 8, y: rect.top + rect.height / 2 };
      }

      function angleFromPointer(ev) {
        const p = pivotPoint();
        return Math.atan2(ev.clientY - p.y, ev.clientX - p.x) * (180 / Math.PI);
      }

      function finish() {
        if (finished) return;
        finished = true;
        el.gachaMachine.removeEventListener('pointerdown', onPointerDown);
        el.gachaMachine.removeEventListener('pointermove', onPointerMove);
        el.gachaMachine.removeEventListener('pointerup', onPointerEnd);
        el.gachaMachine.removeEventListener('pointercancel', onPointerEnd);
        el.gachaMessage.textContent = '';
        el.gachaCapsule.classList.remove('tap-bump');
        el.gachaCapsule.classList.add('pop-out');
        Sound.playClear();
        setTimeout(resolve, 650);
      }

      function onPointerDown(ev) {
        ev.preventDefault();
        dragging = true;
        el.gachaCrank.classList.remove('invite');
        lastPointerAngle = angleFromPointer(ev);
        try { el.gachaMachine.setPointerCapture(ev.pointerId); } catch (e) { /* 対応していない環境は無視 */ }
      }

      function onPointerMove(ev) {
        if (!dragging || finished) return;
        ev.preventDefault();
        const angle = angleFromPointer(ev);
        let delta = angle - lastPointerAngle;
        if (delta > 180) delta -= 360; // 角度のラップアラウンドを補正
        if (delta < -180) delta += 360;
        lastPointerAngle = angle;

        currentAngle += delta;
        totalRotation += Math.abs(delta);
        el.gachaCrank.style.transform = `translateY(-50%) rotate(${currentAngle}deg)`;

        if (Math.floor(totalRotation / GACHA_CLICK_STEP_DEG) > lastClickStep) {
          lastClickStep = Math.floor(totalRotation / GACHA_CLICK_STEP_DEG);
          Sound.playTap();
          el.gachaCapsule.classList.remove('tap-bump');
          void el.gachaCapsule.offsetWidth; // アニメーションを再生し直すための強制リフロー
          el.gachaCapsule.classList.add('tap-bump');
        }

        if (totalRotation >= GACHA_ROTATION_REQUIRED_DEG) {
          finish();
        }
      }

      function onPointerEnd() {
        dragging = false;
      }

      el.gachaMachine.addEventListener('pointerdown', onPointerDown, { passive: false });
      el.gachaMachine.addEventListener('pointermove', onPointerMove, { passive: false });
      el.gachaMachine.addEventListener('pointerup', onPointerEnd);
      el.gachaMachine.addEventListener('pointercancel', onPointerEnd);
    });
  }

  // 等級ごとに演出(紙吹雪・バッジ)を変えて数秒表示してから解決する
  function playPrizeReveal(coupon) {
    return new Promise((resolve) => {
      const reveal = TIER_REVEAL[coupon.tier] || TIER_REVEAL['3等'];
      el.prizeScreen.className = 'screen prize-reveal ' + reveal.theme;
      el.prizeTierBadge.textContent = reveal.badge;
      el.prizeName.textContent = coupon.prizeName;
      spawnConfetti(reveal.confettiCount);
      showScreen('prize');
      Sound.playClear();

      setTimeout(() => {
        el.prizeConfetti.innerHTML = '';
        resolve();
      }, reveal.durationMs);
    });
  }

  function spawnConfetti(count) {
    el.prizeConfetti.innerHTML = '';
    for (let i = 0; i < count; i++) {
      const piece = document.createElement('span');
      piece.className = 'confetti-piece';
      const size = 6 + Math.random() * 8;
      piece.style.left = Math.random() * 100 + '%';
      piece.style.width = size + 'px';
      piece.style.height = size * 1.4 + 'px';
      piece.style.background = CONFETTI_COLORS[Math.floor(Math.random() * CONFETTI_COLORS.length)];
      piece.style.animationDuration = 1.4 + Math.random() * 1.6 + 's';
      piece.style.animationDelay = Math.random() * 0.6 + 's';
      el.prizeConfetti.appendChild(piece);
    }
  }

  function showCouponCard(coupon) {
    // タイトル下の★評価・スコア表示は、クーポンカードと案内文を画面内に収めるためここで非表示にする
    el.resultStars.hidden = true;
    el.resultScore.hidden = true;
    el.couponCard.hidden = false;
    el.couponTier.textContent = `🏆 ${coupon.tier}`;
    el.couponReward.textContent = coupon.prizeName;
    el.couponPresentNote.textContent = PrizeCatalog.getPresentNote(coupon.prizeName);
    el.couponCode.textContent = coupon.code;
    el.couponIssuedAt.textContent = `発行日時: ${formatDateTime(coupon.issuedAt)}`;
    el.couponExpiry.textContent = `有効期限: ${formatDate(coupon.expiresAt)}まで`;
    if (CONFIG_CACHE.storeName) {
      el.couponStore.hidden = false;
      el.couponStore.textContent = `発行店舗: ${CONFIG_CACHE.storeName}`;
    }
    el.screenshotNote.hidden = false;
    el.resultButtons.hidden = false;
    Sound.playClear();
  }

  function resetToStart() {
    showScreen('start');
  }

  // ---- クーポン確認モーダル ----
  // この端末に記憶されたコード一覧をサーバーに照会し、期限内・未使用のものだけを一覧表示する。
  // お客様が使いたいクーポンを選んで提示し、スタッフが「使用済みにする」をタップする。
  let currentDetailCoupon = null;

  function openCouponsModal() {
    el.modalCoupons.hidden = false;
    showCouponsListView();
    loadMyCoupons();
  }

  function closeCouponsModal() {
    el.modalCoupons.hidden = true;
  }

  function showCouponsListView() {
    el.couponsDetail.hidden = true;
    el.couponsList.hidden = true;
    el.couponsEmpty.hidden = true;
    el.couponsError.hidden = true;
    el.couponsLoading.hidden = false;
    el.searchNameInput.value = '';
    el.searchNameError.hidden = true;
  }

  async function loadMyCoupons() {
    const codes = getMyCoupons();
    if (!codes.length) {
      el.couponsLoading.hidden = true;
      el.couponsEmpty.hidden = false;
      return;
    }
    try {
      const { coupons } = await Api.get('checkCoupons', { codes: codes.join(',') });
      const valid = coupons.filter((c) => c.status === 'valid');
      saveMyCoupons(valid.map((c) => c.code)); // 使用済み・期限切れになったコードは記憶から取り除く
      renderCouponsList(valid);
    } catch (err) {
      el.couponsLoading.hidden = true;
      el.couponsError.hidden = false;
      el.couponsError.textContent = 'クーポン情報の取得に失敗しました。通信環境をご確認のうえ、もう一度お試しください。(' + err.message + ')';
    }
  }

  function renderCouponsList(coupons) {
    el.couponsLoading.hidden = true;
    if (!coupons.length) {
      el.couponsEmpty.hidden = false;
      return;
    }
    el.couponsList.hidden = false;
    el.couponsList.innerHTML = '';
    coupons.forEach((c) => {
      const item = document.createElement('button');
      item.type = 'button';
      item.className = 'coupon-list-item';
      item.innerHTML = `
        <span class="tier-badge">${escapeHtml(c.tier)}</span>
        <span class="item-info">
          <span class="item-prize">${escapeHtml(c.prizeName)}</span><br>
          <span class="item-expiry">有効期限: ${formatDate(c.expiresAt)}まで</span>
        </span>
      `;
      item.addEventListener('click', () => showCouponDetail(c));
      el.couponsList.appendChild(item);
    });
  }

  // 端末の記憶が消えている/別端末で遊んだお客様向けに、保護者氏名で直接検索できるようにする
  async function searchByName() {
    const name = el.searchNameInput.value.trim();
    el.searchNameError.hidden = true;
    if (!name) {
      el.searchNameError.hidden = false;
      el.searchNameError.textContent = 'お名前を入力してください';
      return;
    }

    el.btnSearchName.disabled = true;
    el.btnSearchName.textContent = '検索中...';
    try {
      const { coupons } = await Api.get('searchByName', { name });
      if (!coupons.length) {
        el.searchNameError.hidden = false;
        el.searchNameError.textContent = '入力されたお名前で、確認できるクーポンが見つかりませんでした';
        return;
      }
      coupons.forEach((c) => addMyCoupon(c.code)); // 見つかったコードはこの端末にも覚えさせておく(次回から自動で出てくるように)
      el.couponsEmpty.hidden = true;
      renderCouponsList(coupons);
    } catch (err) {
      el.searchNameError.hidden = false;
      el.searchNameError.textContent = '検索に失敗しました。(' + err.message + ')';
    } finally {
      el.btnSearchName.disabled = false;
      el.btnSearchName.textContent = '検索する';
    }
  }

  el.btnSearchName.addEventListener('click', searchByName);
  el.searchNameInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') searchByName();
  });

  function showCouponDetail(coupon) {
    currentDetailCoupon = coupon;
    el.couponsList.hidden = true;
    el.couponsEmpty.hidden = true;
    el.couponsDetail.hidden = false;
    el.detailTier.textContent = `🏆 ${coupon.tier}`;
    el.detailReward.textContent = coupon.prizeName;
    el.detailPresentNote.textContent = PrizeCatalog.getPresentNote(coupon.prizeName);
    el.detailCode.textContent = coupon.code;
    el.detailIssuedAt.textContent = `発行日時: ${formatDateTime(coupon.issuedAt)}`;
    el.detailExpiry.textContent = `有効期限: ${formatDate(coupon.expiresAt)}まで`;
    el.detailConfirm.hidden = false;
    el.detailConfirmCheck.hidden = true;
    el.markUsedError.hidden = true;
    el.markUsedSuccess.hidden = true;
    el.btnMarkUsed.hidden = false;
  }

  function backToCouponsList() {
    currentDetailCoupon = null;
    showCouponsListView();
    loadMyCoupons();
  }

  el.btnMarkUsed.addEventListener('click', () => {
    el.detailConfirm.hidden = true;
    el.detailConfirmCheck.hidden = false;
  });

  el.btnMarkUsedNo.addEventListener('click', () => {
    el.detailConfirmCheck.hidden = true;
    el.detailConfirm.hidden = false;
  });

  el.btnMarkUsedYes.addEventListener('click', async () => {
    if (!currentDetailCoupon) return;
    const code = currentDetailCoupon.code;
    el.btnMarkUsedYes.disabled = true;
    el.btnMarkUsedNo.disabled = true;
    try {
      await Api.post('markUsed', { code });
      const codes = getMyCoupons().filter((c) => c !== code);
      saveMyCoupons(codes);
      el.detailConfirmCheck.hidden = true;
      el.markUsedSuccess.hidden = false;
    } catch (err) {
      el.markUsedError.hidden = false;
      el.markUsedError.textContent = '使用済みにできませんでした。(' + err.message + ')';
      el.detailConfirmCheck.hidden = true;
      el.detailConfirm.hidden = false;
    } finally {
      el.btnMarkUsedYes.disabled = false;
      el.btnMarkUsedNo.disabled = false;
    }
  });

  el.btnCheckCoupons.addEventListener('click', openCouponsModal);
  el.modalCouponsClose.addEventListener('click', closeCouponsModal);
  el.btnCouponDetailBack.addEventListener('click', backToCouponsList);

  function escapeHtml(s) {
    return String(s).replace(
      /[&<>"']/g,
      (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])
    );
  }

  el.btnStart.addEventListener('click', startCountdown);
  el.btnRetry.addEventListener('click', startCountdown);
  el.btnFinish.addEventListener('click', resetToStart);

  updateSoundButton();
  showScreen('start');
})();
