import type { ButtonHTMLAttributes, ReactNode } from 'react';

/** Simple line icons. Inline SVG only — no icon kit and no user CSS. */
export type IconName =
  | 'games' | 'board' | 'cam' | 'mic' | 'settings' | 'screen' | 'key' | 'stream'
  | 'bot' | 'lock' | 'unlock' | 'slow' | 'purge' | 'trash' | 'people' | 'leave'
  | 'eye' | 'eyeOff' | 'grip' | 'more' | 'sounds' | 'home' | 'plus' | 'panel' | 'user' | 'rail' | 'download' | 'music' | 'watch' | 'fx'
  | 'search' | 'bookmark' | 'calendar' | 'poll' | 'image' | 'stats' | 'link';

const PATHS: Record<IconName, ReactNode> = {
  games: <><rect x="6" y="8" width="12" height="8" rx="2" /><path d="M9 12h2M10 11v2M15 11.5h.01M16.5 13.5h.01" /></>,
  board: <><rect x="4" y="5" width="16" height="12" rx="1.5" /><path d="M8 19h8M12 17v2" /></>,
  cam: <><path d="M4 8h10a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V9a1 1 0 0 1 1-1z" /><path d="M15 11l5-2v6l-5-2z" /></>,
  mic: <><rect x="9" y="3" width="6" height="11" rx="3" /><path d="M6 11a6 6 0 0 0 12 0M12 17v4" /></>,
  settings: <><circle cx="12" cy="12" r="3" /><path d="M12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6l1.4 1.4M17 17l1.4 1.4M18.4 5.6 17 7M7 17l-1.4 1.4" /></>,
  screen: <><rect x="3" y="5" width="18" height="12" rx="1.5" /><path d="M8 21h8M12 17v4" /></>,
  key: <><circle cx="8" cy="14" r="3" /><path d="M11 14h10l-2 2 2 2h-3" /></>,
  stream: <><path d="M5 9a7 7 0 0 1 14 0" /><path d="M8 12a4 4 0 0 1 8 0" /><circle cx="12" cy="16" r="1.4" fill="currentColor" stroke="none" /></>,
  bot: <><rect x="5" y="8" width="14" height="10" rx="2" /><path d="M12 8V5M9 13h.01M15 13h.01M9 4h6" /></>,
  lock: <><rect x="6" y="11" width="12" height="8" rx="1.5" /><path d="M8 11V8a4 4 0 0 1 8 0v3" /></>,
  unlock: <><rect x="6" y="11" width="12" height="8" rx="1.5" /><path d="M8 11V8a4 4 0 0 1 7.5-2" /></>,
  slow: <><circle cx="12" cy="13" r="7" /><path d="M12 10v4l2 2M12 4v2" /></>,
  purge: <><path d="M5 8h14M9 8V6h6v2M8 8l1 12h6l1-12" /></>,
  trash: <><path d="M5 8h14M9 8V6h6v2M8 8l1 12h6l1-12M10 12v5M14 12v5" /></>,
  people: <><circle cx="9" cy="9" r="2.2" /><circle cx="16" cy="10" r="1.7" /><path d="M4.5 18c.6-2.4 2.4-3.5 4.5-3.5s3.9 1.1 4.5 3.5M14 14.6c1.2-.4 2.4-.1 3.5.8 1 .8 1.4 1.7 1.6 2.6" /></>,
  leave: <><path d="M10 6H6v12h4M10 12h8M15 9l3 3-3 3" /></>,
  eye: <><path d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6S2 12 2 12z" /><circle cx="12" cy="12" r="2.5" /></>,
  eyeOff: <><path d="M4 5l16 14M9.5 9.7A3 3 0 0 0 12 15a3 3 0 0 0 2.2-.9" /><path d="M6.2 7.4C3.8 9 2 12 2 12s3.5 6 10 6c1.6 0 3-.3 4.2-.9M10 6.2A10 10 0 0 1 12 6c6.5 0 10 6 10 6a17 17 0 0 1-3.2 3.6" /></>,
  grip: <><path d="M9 7h.01M15 7h.01M9 12h.01M15 12h.01M9 17h.01M15 17h.01" /></>,
  more: <path d="M5 7h14M5 12h14M5 17h14" />,
  sounds: <><path d="M4 10v4h3l4 3V7L7 10H4z" /><path d="M16 9.5a3.5 3.5 0 0 1 0 5" /><path d="M18 7a6.5 6.5 0 0 1 0 10" /></>,
  home: <><path d="M4 11l8-7 8 7" /><path d="M6 10v9h12v-9" /></>,
  plus: <path d="M12 5v14M5 12h14" />,
  panel: <><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M15 4v16" /></>,
  user: <><circle cx="12" cy="8" r="3" /><path d="M5.5 19c.8-3 3.2-4.5 6.5-4.5s5.7 1.5 6.5 4.5" /></>,
  rail: <><circle cx="7" cy="6" r="2" /><circle cx="7" cy="12" r="2" /><circle cx="7" cy="18" r="2" /><path d="M13 6h7M13 12h7M13 18h7" /></>,
  download: <><path d="M12 4v10" /><path d="M8 10l4 4 4-4" /><path d="M5 18h14" /></>,
  watch: <><rect x="3" y="5" width="18" height="12" rx="1.5" /><path d="M10 8.5v5l4-2.5z" fill="currentColor" stroke="none" /><path d="M8 20h8" /></>,
  fx: <><path d="M5 19l6-14 2 6 6 2z" /><path d="M16 4v2M20 8h-2M18.5 5.5l-1.4 1.4" /></>,
  link: <><path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1" /><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1" /></>,
  search: <><circle cx="11" cy="11" r="6" /><path d="M20 20l-4.5-4.5" /></>,
  bookmark: <path d="M7 4h10v16l-5-3.5L7 20z" />,
  calendar: <><rect x="4" y="6" width="16" height="14" rx="1.5" /><path d="M4 10h16M9 4v4M15 4v4" /></>,
  poll: <><path d="M5 20V10M12 20V5M19 20v-7" /></>,
  stats: <><path d="M4 20h16" /><path d="M4 16l5-5 4 3 7-8" /><path d="M16 6h4v4" /></>,
  image: <><rect x="3" y="5" width="18" height="14" rx="2" /><circle cx="9" cy="10" r="1.6" /><path d="M21 16l-5-5-8 8" /></>,
  music: <><path d="M9 18V6l10-2v12" /><circle cx="6" cy="18" r="2.4" fill="currentColor" stroke="none" /><circle cx="16" cy="16" r="2.4" fill="currentColor" stroke="none" /></>,
};

export function Icon({ name, size = 18 }: { name: IconName; size?: number }) {
  return (
    <svg className="line-icon" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {PATHS[name]}
    </svg>
  );
}

/** Icon-only button. `title` and `aria-label` are the same words. */
export function IconAction({
  label, icon, className = '', type = 'button', ...rest
}: { label: string; icon: IconName } & ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button type={type} {...rest} title={label} aria-label={label} className={`btn icon-act ${className}`.trim()}>
      <Icon name={icon} />
    </button>
  );
}
