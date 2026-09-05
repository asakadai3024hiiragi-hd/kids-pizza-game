// config.js - GAS Web App の接続先などをまとめる設定ファイル
// デプロイ後、Google Apps Scriptの「ウェブアプリのURL」をここに貼り付けてください。
// 手順は README.md の「Google Apps Script デプロイ手順」を参照してください。
const GAS_CONFIG = {
  // 例: 'https://script.google.com/macros/s/xxxxxxxxxxxxxxxx/exec'
  WEB_APP_URL: 'https://script.google.com/macros/s/AKfycbzRmKdvkfC-iOWBicYP0vWVcA9e26E4qgorYgC-eP76pmofokD3cJWkxP2c1PeakTO8Og/exec',

  // 複数店舗対応: URLに ?store=店舗名 が付いていない場合に使う既定の店舗名。
  // gas/Code.gs の DEFAULT_STORE と必ず同じ文字列にすること。
  // 新しい店舗を追加するときは、その店舗用のQRコードのURLに ?store=新しい店舗名 を付ければよく、
  // この既定値(今までのQR・URL用)は変更不要。
  STORE_NAME: '朝霞台店',
};
