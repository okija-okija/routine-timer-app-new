import { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  // アプリの一意なID（変更不可）
  appId: 'com.routinetimer.app',
  // ホーム画面に表示されるアプリ名
  appName: 'ルーティンタイマー',
  // HTML/JSファイルが格納されているフォルダ名（超重要）
  webDir: 'www',
  server: {
    // Androidでローカルファイルを正しく読み込むための設定
    androidScheme: 'https'
  }
};

export default config;
