import { chatColorClass, chatColorHex, chatEffectClass, isChatColorId } from '../../shared/colors';
import { colorFor } from '../util';

/** Letter or uploaded avatar for a user. */
export function UserAvatar({
  nick,
  accountId,
  chatColor,
  hasAvatar,
  size = 22,
  className = '',
}: {
  nick: string;
  accountId?: number | null;
  chatColor?: string | null;
  hasAvatar?: boolean;
  size?: number;
  className?: string;
}) {
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
  const cls = chatColorClass(id);
  const fx = chatEffectClass(chatEffect);
  const style = cls ? undefined : { color: colorFor(nick) };
  return (
    <span className={`nick-label ${cls || ''} ${fx || ''} ${className}`.trim()} style={style}>
      {nick}
    </span>
  );
}
