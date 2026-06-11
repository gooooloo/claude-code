import type { CapacitorConfig } from '@capacitor/cli'

const config: CapacitorConfig = {
  appId: 'best.claudecode.transcripts',
  appName: 'Claude Transcripts',
  webDir: 'dist',
  ios: {
    // WKWebView 铺满到屏幕边缘，安全区由 CSS env(safe-area-inset-*) 处理
    contentInset: 'never',
    // 启动到 webview 就绪期间的背景，取暖石浅色，避免白闪
    backgroundColor: '#efeee9',
  },
}

export default config
