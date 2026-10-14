/** Category + tag display. Kept apart from RoomManage so the lobby does not pull in the editors. */
import { CATEGORY_ICON, CATEGORY_LABEL, isRoomCategory, ROOM_CATEGORIES } from '../../shared/batch3';

export function CategoryTag({ category }: { category?: string | null }) {
  if (!isRoomCategory(category)) return null;
  return <span className="cat-tag" data-category={category}>{CATEGORY_ICON[category]} {CATEGORY_LABEL[category]}</span>;
}
export function TagList({ tags, onPick }: { tags?: string[]; onPick?: (t: string) => void }) {
  if (!tags?.length) return null;
  return (
    <span className="tag-list">
      {tags.map((t) => onPick
        ? <button key={t} type="button" className="room-tag" data-tag={t} onClick={(e) => { e.stopPropagation(); onPick(t); }}>#{t}</button>
        : <span key={t} className="room-tag" data-tag={t}>#{t}</span>)}
    </span>
  );
}
export function CategorySelect({ value, onChange, id }: { value: string; onChange: (v: string) => void; id?: string }) {
  return (
    <select id={id} value={value} onChange={(e) => onChange(e.target.value)} aria-label="Category" data-field="room-category">
      <option value="">No category</option>
      {ROOM_CATEGORIES.map((c) => <option key={c} value={c}>{CATEGORY_ICON[c]} {CATEGORY_LABEL[c]}</option>)}
    </select>
  );
}
