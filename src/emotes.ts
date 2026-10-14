import { createContext, useContext } from 'react';
import type { RoomEmote } from '../shared/types';

/** Emotes of the room being viewed (name -> id); ChatText renders :name: from it. */
export const EmoteContext = createContext<ReadonlyMap<string, string> | null>(null);
export const useEmoteMap = () => useContext(EmoteContext);
export const emoteMap = (list: RoomEmote[] | undefined): ReadonlyMap<string, string> => new Map((list ?? []).map((e) => [e.name, e.id]));
