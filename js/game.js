// game.js - ピザ職人チャレンジ ゲームロジック
// 生地→トマトソース→チーズ→具材の順番にタップしてピザを完成させる
(function () {
  const STEP_DEFS = [
    { key: 'dough', emoji: '🫓', label: '生地' },
    { key: 'sauce', emoji: '🍅', label: 'トマトソース' },
    { key: 'cheese', emoji: '🧀', label: 'チーズ' },
  ];
  const TOPPING_CHOICES = ['🍄', '🫑', '🍍', '🌽', '🫒', '🥓'];

  // GASが未設定/未応答でもゲームが遊べるようにするデフォルト設定
  const DEFAULT_CONFIG = {
    gameDuration: 30,
    pointsPerPizza: 20,
    couponScoreThreshold: 100,
    rewardTextToday: 'ジェラート無料券',
    rewardTextNextTime: '次回来店10%OFF券',
  };

  const CLAIM_STORAGE_KEY = 'kg_coupon_claimed_at';
  const CLAIM_COOLDOWN_MS = 10 * 60 * 60 * 1000; // この端末での再取得までの待機時間(10時間)

  const screens = {
    start: document.getElementById('screen-start'),
    countdown: document.getElementById('screen-countdown'),
    game: document.getElementById('screen-game'),
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
    couponReward: document.getElementById('coupon-reward'),
    couponCode: document.getElementById('coupon-code'),
    couponIssuedAt: document.getElementById('coupon-issued-at'),
    couponExpiry: document.getElementById('coupon-expiry'),
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
  function buildRoundDefs() {
    const topping = TOPPING_CHOICES[Math.floor(Math.random() * TOPPING_CHOICES.length)];
    return [...STEP_DEFS, { key: 'topping', emoji: topping, label: '具材' }];
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
  }

  function clearItems() {
    activeItems.forEach((item) => item.el.remove());
    activeItems.length = 0;
  }

  function placeItem(stepIndex) {
    const def = currentRound[stepIndex];
    const node = document.createElement('div');
    node.className = 'ingredient';
    node.textContent = def.emoji;

    const areaRect = el.playArea.getBoundingClientRect();
    const size = 68;
    const maxX = Math.max(areaRect.width - size, 10);
    const maxY = Math.max(areaRect.height * 0.55 - size, 10);
    node.style.left = Math.random() * maxX + 'px';
    node.style.top = Math.random() * maxY + 'px';

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
  }

  function handleTap(stepIndex, node) {
    if (stepIndex === currentStepIndex) {
      Sound.playSuccess();
      node.classList.add('fade-out');
      const idx = activeItems.findIndex((it) => it.el === node);
      if (idx >= 0) activeItems.splice(idx, 1);
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

    el.couponForm.hidden = true;
    el.couponCard.hidden = true;
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
    const useTiming = el.couponForm.useTiming.value; // 'today' | 'next'
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
        useTiming,
      });
      markClaimed();
      el.couponForm.hidden = true;
      el.couponCard.hidden = false;
      el.couponReward.textContent =
        coupon.rewardText || (useTiming === 'next' ? CONFIG_CACHE.rewardTextNextTime : CONFIG_CACHE.rewardTextToday);
      el.couponCode.textContent = coupon.code;
      el.couponIssuedAt.textContent = `発行日時: ${formatDateTime(coupon.issuedAt)}`;
      el.couponExpiry.textContent = `有効期限: ${formatDate(coupon.expiresAt)}まで`;
      el.screenshotNote.hidden = (coupon.useTiming || useTiming) !== 'next';
      el.resultButtons.hidden = false;
    } catch (err) {
      el.couponFormError.hidden = false;
      el.couponFormError.textContent = 'クーポンの発行に失敗しました。スタッフにお知らせください。(' + err.message + ')';
    } finally {
      el.btnSubmitCoupon.disabled = false;
      el.btnSubmitCoupon.textContent = 'クーポンをもらう';
    }
  });

  function resetToStart() {
    showScreen('start');
  }

  el.btnStart.addEventListener('click', startCountdown);
  el.btnRetry.addEventListener('click', startCountdown);
  el.btnFinish.addEventListener('click', resetToStart);

  updateSoundButton();
  showScreen('start');
})();
