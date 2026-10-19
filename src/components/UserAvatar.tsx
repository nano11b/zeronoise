import { publicAvatarFx } from '../../shared/avatarFx';
import { msgStyleCss, safeMsgStyle } from '../../shared/msgColor';
import { chatColorClass, chatColorHex, chatEffectClass, isChatColorId } from '../../shared/colors';
import { colorFor } from '../util';

/** Letter or uploaded avatar for a user. */
export function UserAvatar({
  nick,
  accountId,
  chatColor,
  hasAvatar,
  avatarFx,
  size = 22,
  className = '',
}: {
  nick: string;
  accountId?: number | null;
  chatColor?: string | null;
  hasAvatar?: boolean;
  /** MC2 profile effect (frame / glow); hidden by html.no-avatar-fx */
  avatarFx?: string | null;
  size?: number;
  className?: string;
}) {
  const fxId = publicAvatarFx(avatarFx);
  if (fxId) className = `${className} avatar-fx avatar-fx-${fxId}`;
  const letter = (nick || '?').slice(0, 1).toUpperCase();
  const id = isChatColorId(chatColor) ? chatColor : null;
  const bg = chatColorHex(id) || colorFor(nick);
  const cls = chatColorClass(id);
  if (hasAvatar && accountId) {
    return (
      <img
        className={`user-avatar ${className}`.trim()}
        src={`/api/avatars/${accountId}.webp`}
        alt=""
        width={size}
        height={size}
        style={{ width: size, height: size }}
        loading="lazy"
      />
    );
  }
  return (
    <span
      className={`user-avatar letter ${cls || ''} ${className}`.trim()}
      style={{ width: size, height: size, fontSize: Math.round(size * 0.48), background: cls ? undefined : bg, color: cls ? undefined : '#0b0d15' }}
      aria-hidden
    >
      {letter}
    </span>
  );
}

export function NickLabel({
  nick,
  chatColor,
  chatEffect,
  className = '',
}: {
  nick: string;
  chatColor?: string | null;
  chatEffect?: string | null;
  className?: string;
}) {
  const id = isChatColorId(chatColor) ? chatColor : null;
  // MC2: name gradient (stored as g:...; every stop re-checked); the gradient/pulse effects would fight it, glow is kept
  const grad = !id ? safeMsgStyle(chatColor) : null;
  const gcss = grad?.kind === 'gradient' ? msgStyleCss(grad) : null;
  const cls = gcss ? 'nick-grad' : chatColorClass(id);
  const fx0 = chatEffectClass(chatEffect);
  const fx = gcss && fx0 && fx0 !== 'nick-fx-glow' ? undefined : fx0;
  const style = gcss ? (gcss.style as React.CSSProperties) : cls ? undefined : { color: colorFor(nick) };
  return (
    <span className={`nick-label ${cls || ''} ${fx || ''} ${className}`.trim()} style={style}>
      {nick}
    </span>
  );
}
