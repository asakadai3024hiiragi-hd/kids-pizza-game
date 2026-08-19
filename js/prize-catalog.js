// prize-catalog.js - 景品名の一覧と、それぞれの提示タイミング(会計時/ご注文時)を定義する共通ファイル
// admin.html(景品設定のプルダウン)・index.html(クーポン画面の案内文)の両方から読み込む。
// 誤字防止のため、景品名はここに定義した一覧からのみ選べるようにする。
(function (global) {
  const PRIZE_CATALOG = [
    { name: '50円引きクーポン', presentWhen: 'checkout' },
    { name: '100円引きクーポン', presentWhen: 'checkout' },
    { name: '5%引きクーポン', presentWhen: 'checkout' },
    { name: '10%引きクーポン', presentWhen: 'checkout' },
    { name: '20%引きクーポン', presentWhen: 'checkout' },
    { name: '無料ドリンクバープレゼント', presentWhen: 'order' },
    { name: '無料シングルジェラートプレゼント', presentWhen: 'order' },
    { name: '無料Lサイズクーポン', presentWhen: 'order' },
    { name: 'キッズプレート半額クーポン', presentWhen: 'order' },
    { name: 'キッズプレート無料クーポン', presentWhen: 'order' },
    { name: 'お好きなパスタ無料クーポン', presentWhen: 'order' },
  ];

  // 会計時に提示する(値引き系)か、ご注文時に提示する(品目プレゼント系)かの案内文
  const PRESENT_NOTE_TEXT = {
    checkout: '💳 会計時にスタッフにご提示ください',
    order: '📝 ご注文時にスタッフにご提示ください',
  };

  // 景品名から提示タイミングを調べる。一覧に無い(古い設定などの)名前は、
  // 安全側として「会計時」扱いにフォールバックする
  function getPresentNote(prizeName) {
    const found = PRIZE_CATALOG.find((p) => p.name === prizeName);
    const when = found ? found.presentWhen : 'checkout';
    return PRESENT_NOTE_TEXT[when];
  }

  global.PrizeCatalog = { PRIZE_CATALOG: PRIZE_CATALOG, getPresentNote: getPresentNote };
})(window);
