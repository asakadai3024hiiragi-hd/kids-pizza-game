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
  const GACHA_TAPS_REQUIRED = 6; // ガチャを回し切るまでに必要なタップ回数
  const GACHA_HANDLE_DEGREES_PER_TAP = 65;

  // 等級ごとの当選演出設定(特等が最も派手・長い)
  const TIER_REVEAL = {
    '特等': { theme: 'tier-grand', durationMs: 3800, confettiCount: 40, badge: '🏆 特等!!' },
    '1等': { theme: 'tier-1', durationMs: 3200, confettiCount: 26, badge: '🎉 1等!' },
    '2等': { theme: 'tier-2', durationMs: 2600, confettiCount: 16, badge: '✨ 2等!' },
    '3等': { theme: 'tier-3', durationMs: 2200, confettiCount: 8, badge: '🎊 3等!' },
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
    progressDots: Array.from(document.querySelectorAll('#progress-steps .progress-dot')),
    nextGuide: document.getElementById('next-guide'),
    missLockOverlay: document.getElementById('miss-lock-overlay'),
    missLockCountdown: document.getElementById('miss-lock-countdown'),
    gachaMachine: document.getElementById('gacha-machine'),
    gachaHandle: document.getElementById('gacha-handle'),
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
    couponCode: document.getElementById('coupon-code'),
    couponIssuedAt: document.getElementById('coupon-issued-at'),
    couponExpiry: document.getElementById('coupon-expiry'),
    couponStore: document.getElementById('coupon-store'),
    presentNote: document.getElementById('present-note'),
    screenshotNote: document.getElementById('screenshot-note'),
    resultButtons: document.getElementById('result-buttons'),
    btnStart: document.getElementById('btn-start'),
    btnRetry: document.getElementById('btn-retry'),
    btnFinish: document.getElementById('btn-finish'),
    btnSoundToggle: document.getElementById('btn-sound-toggle'),
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
    updateProgressDots();
    renderRoundItems();
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
    el.progressDots.forEach((dot, i) => {
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
  async function startCountdown() {
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

  function showResult() {
    showScreen('result');
    const evalResult = evaluateScore(score);
    el.resultTitle.textContent = evalResult.title;
    el.resultStars.textContent = '★'.repeat(evalResult.stars) + '☆'.repeat(5 - evalResult.stars);
    el.resultScore.textContent = `獲得スコア: ${score}点`;

    currentCouponCode = null;
    el.couponForm.hidden = true;
    el.couponCard.hidden = true;
    el.couponStore.hidden = true;
    el.resultMessage.hidden = true;
    el.alreadyClaimedMessage.hidden = true;
    el.presentNote.hidden = true;
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

  // ハンドルをタップした回数分だけ実際に回り、必要回数タップし終わるとカプセルが出てくる
  function playGachaAnimation() {
    return new Promise((resolve) => {
      showScreen('gacha');
      let taps = 0;
      el.gachaCapsule.className = 'gacha-capsule';
      el.gachaHandle.style.transform = 'rotate(0deg)';
      el.gachaHandle.classList.add('invite');
      el.gachaMessage.textContent = 'ハンドルをタップして回してね!';

      function onTap(ev) {
        ev.preventDefault();
        el.gachaHandle.classList.remove('invite');
        taps += 1;
        Sound.playTap();
        el.gachaHandle.style.transform = `rotate(${taps * GACHA_HANDLE_DEGREES_PER_TAP}deg)`;
        el.gachaCapsule.classList.remove('tap-bump');
        void el.gachaCapsule.offsetWidth; // アニメーションを再生し直すための強制リフロー
        el.gachaCapsule.classList.add('tap-bump');

        if (taps >= GACHA_TAPS_REQUIRED) {
          el.gachaMachine.removeEventListener('pointerdown', onTap);
          el.gachaMessage.textContent = 'ジャジャーン!';
          el.gachaCapsule.classList.remove('tap-bump');
          el.gachaCapsule.classList.add('pop-out');
          Sound.playClear();
          setTimeout(resolve, 650);
        } else {
          el.gachaMessage.textContent = `あと${GACHA_TAPS_REQUIRED - taps}回!`;
        }
      }

      el.gachaMachine.addEventListener('pointerdown', onTap, { passive: false });
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
    el.couponCard.hidden = false;
    el.couponTier.textContent = `🏆 ${coupon.tier}`;
    el.couponReward.textContent = coupon.prizeName;
    el.couponCode.textContent = coupon.code;
    el.couponIssuedAt.textContent = `発行日時: ${formatDateTime(coupon.issuedAt)}`;
    el.couponExpiry.textContent = `有効期限: ${formatDate(coupon.expiresAt)}まで`;
    if (CONFIG_CACHE.storeName) {
      el.couponStore.hidden = false;
      el.couponStore.textContent = `発行店舗: ${CONFIG_CACHE.storeName}`;
    }
    el.presentNote.hidden = false;
    el.screenshotNote.hidden = false;
    el.resultButtons.hidden = false;
    Sound.playClear();
  }

  function resetToStart() {
    showScreen('start');
  }

  el.btnStart.addEventListener('click', startCountdown);
  el.btnRetry.addEventListener('click', startCountdown);
  el.btnFinish.addEventListener('click', resetToStart);

  updateSoundButton();
  showScreen('start');
})();
