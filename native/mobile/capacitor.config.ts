import type { CapacitorConfig } from '@capacitor/cli';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const shared = JSON.parse(readFileSync(join(__dirname, '..', 'config.json'), 'utf8')) as {
  appId: string;
  appName: string;
  siteUrl: string;
  host: string;
  userAgentSuffix: string;
};

const config: CapacitorConfig = {
  appId: shared.appId,
  appName: shared.appName,
  webDir: 'www',
  server: {
    url: shared.siteUrl,
    androidScheme: 'https',
    allowNavigation: [shared.host],
    errorPath: 'offline.html',
  },
  android: {
    appendUserAgent: shared.userAgentSuffix,
    backgroundColor: '#030605',
    allowMixedContent: false,
  },
  ios: {
    appendUserAgent: shared.userAgentSuffix,
    backgroundColor: '#030605',
    contentInset: 'automatic',
    scrollEnabled: true,
  },
};

export default config;
