import type { CapacitorConfig } from '@capacitor/cli'

const config: CapacitorConfig = {
  appId: 'best.claudecode.transcripts',
  appName: 'Claude Transcripts',
  webDir: 'dist',
  android: {
    // 允许 EventSource/fetch 访问 devtunnel 的 https 域名
    allowMixedContent: false,
  },
}

export default config
